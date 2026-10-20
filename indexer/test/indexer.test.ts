import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore, type Entry } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer, type Audience, type Publisher } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const H = 3600;
// As live: a mirrored calendar's events are listed as the index key's items.
const ITEMS_HEADER = `39998:${'ab'.repeat(32)}:events`;
const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === ITEMS_HEADER);

function entryFor(fixture: string, extra: Partial<Entry> = {}): Entry {
  const id = identify(feedUrlFor(fixture));
  return { d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
    location: null, g: null, foundVia: null, addedAt: NOW - 86400, ...extra };
}

function harness(options: { fixtures: string[]; texts?: Record<string, string>; failing?: string[]; publishGeneral?: boolean; rsvps?: Set<string>; dataDir?: string;
  onPublish?: (list: VerifiedEvent[], audience: Audience) => void; db?: ReturnType<typeof openIndexDb>; vault?: ReturnType<typeof openVault>; indexKey?: Uint8Array;
  fetchOwn?: Publisher['fetchOwn']; pendingFor?: (relay: string) => number; publishDirectory?: boolean; generalRelays?: string; header?: string; maxPollsPerTick?: number;
  // Feeds the fake fetch answers for, beyond the filed fixtures.
  extraFeeds?: string[] }) {
  const db = options.db ?? openIndexDb(':memory:');
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const events = eventStore(db);
  const vault = options.vault ?? openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = options.indexKey ?? generateSecretKey();
  const sent: Array<{ audience: Audience; event: VerifiedEvent; relays?: string[] }> = [];
  const fetched: string[] = [];
  const clock = { now: NOW };
  const urls = new Map([...options.fixtures, ...(options.extraFeeds ?? [])].map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const settings = {
    ...loadSettings({ EVENTINDEX_DATA_DIR: options.dataDir ?? '/nonexistent', EVENTINDEX_SEARCH_RELAYS: 'wss://search.test', EVENTINDEX_LIST_RELAYS: 'wss://lists.test',
      EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: ITEMS_HEADER,
      ...(options.generalRelays ? { EVENTINDEX_GENERAL_RELAYS: options.generalRelays } : {}) }),
    publishToGeneralRelays: options.publishGeneral ?? false,
    publishDirectoryOutside: options.publishDirectory ?? false,
    ...(options.header ? { directoryHeader: options.header } : {}),
  };
  const indexer = createIndexer({
    db, dir, queues, events, vault, indexKey, settings,
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => {
      fetched.push(url);
      const fixture = urls.get(url);
      if (!fixture || options.failing?.includes(fixture)) return { status: 'error', code: 'http-500' };
      return { status: 'ok', text: options.texts?.[fixture] ?? readFixture(fixture), etag: null, lastModified: null, finalUrl: url };
    },
    publisher: {
      publish: async (list, audience, relays) => {
        options.onPublish?.(list, audience);
        sent.push(...list.map((event) => ({ audience, event, ...(relays ? { relays } : {}) })));
      },
      rsvps: async () => options.rsvps ?? new Set(),
      ...(options.fetchOwn ? { fetchOwn: options.fetchOwn } : {}),
      ...(options.pendingFor ? { pendingFor: options.pendingFor } : {}),
      close: () => {},
    },
    log: () => {},
    ...(options.maxPollsPerTick ? { maxPollsPerTick: options.maxPollsPerTick } : {}),
  });
  for (const fixture of options.fixtures) if (!dir.get(entryFor(fixture).d)) dir.add(entryFor(fixture));
  return { db, dir, queues, events, vault, indexKey, indexPubkey: getPublicKey(indexKey), sent, fetched, clock, indexer };
}

test('a tick polls the due calendars, lists their events as items, and stores their name and events', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'] });
  const report = await h.indexer.tick();
  assert.deepEqual(report.polled, ['meetup:pythonsd']);
  const entry = h.dir.get('meetup:pythonsd')!;
  assert.equal(entry.name, 'San Diego Python Users Group');
  assert.equal(h.sent.filter((s) => s.audience === 'own' && isItem(s.event)).length, 4);
  assert.ok(h.sent.every((s) => s.event.pubkey === h.indexPubkey && verifyEvent(s.event)), 'the index key signs everything');
  assert.equal(h.events.countByCalendar('meetup:pythonsd'), 4);
  assert.equal(h.dir.fact('index_pubkey'), h.indexPubkey);
});

test('the index key publishes its profile, both headers and the directory entries', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await h.indexer.tick();
  const own = h.sent.filter((s) => s.audience === 'own' && s.event.pubkey === h.indexPubkey && !isItem(s.event)).map((s) => s.event);
  assert.deepEqual(own.map((e) => e.kind).sort((a, b) => a - b), [0, 3, 10002, 39998, 39999]);
  assert.deepEqual(own.find((e) => e.kind === 39998)!.tags[0], ['d', 'events'], 'only the events header; the calendars header is a maintainer\'s');
  const entry = own.find((e) => e.kind === 39999)!;
  assert.equal(entry.tags.find((t) => t[0] === 'p'), undefined, 'a calendar whose organizer named no key names none');
  assert.deepEqual(own.find((e) => e.kind === 3)!.tags, [], 'the index key follows no one');
  assert.deepEqual(JSON.parse(own.find((e) => e.kind === 0)!.content), {
    name: 'Event Index',
    about: 'The open directory of public event calendars. Mirrors them as nostr calendars so any app can render them. eventindex.space',
    picture: 'https://eventindex.space/brand/mark-tile-512.png',
    website: 'https://eventindex.space',
    nip05: '_@eventindex.space',
  });
  const sent = h.sent.length;
  await h.indexer.tick();
  assert.equal(h.sent.length, sent, 'unchanged events are not sent again');
});

const outside = (sent: Array<{ audience: Audience; event: VerifiedEvent }>, audience: Audience, pubkey?: string) =>
  sent.filter((s) => s.audience === audience && (!pubkey || s.event.pubkey === pubkey)).map((s) => s.event.kind).sort((a, b) => a - b);

test('with outside publishing off, only the index key\'s profile and relay list leave its relay', async () => {
  const off = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await off.indexer.tick();
  assert.deepEqual(outside(off.sent, 'profiles'), [0, 10002]);
  assert.deepEqual(outside(off.sent, 'general'), [0, 10002]);
  assert.ok(off.sent.filter((s) => s.audience !== 'own').every((s) => s.event.pubkey === off.indexPubkey));
  assert.deepEqual(outside(off.sent, 'search'), []);
  assert.deepEqual(outside(off.sent, 'lists'), []);
});

test('with it on, each set of relays gets its kinds', async () => {
  const on = harness({ fixtures: ['meetup-pythonsd.ics'], publishGeneral: true, publishDirectory: true });
  await on.indexer.tick();
  assert.ok(on.sent.every((s) => s.event.pubkey === on.indexPubkey), 'nothing but the index key');
  assert.deepEqual(outside(on.sent, 'search'), [0, 3, 10002, 39999, 39999, 39999, 39999, 39999], 'its entry and items, never a header the index key signs');
  assert.deepEqual(outside(on.sent, 'lists'), [39999, 39999, 39999, 39999, 39999]);
  assert.deepEqual(outside(on.sent, 'profiles'), [0, 3, 10002]);
  assert.deepEqual(outside(on.sent, 'general'), [0, 3, 10002], 'no item goes to the general relays');
});

test('turning outside publishing on sends what the index\'s relay holds to each relay once, marked when its queue drains', async () => {
  const first = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await first.indexer.tick();
  const held = first.sent.filter((s) => s.audience === 'own').map((s) => s.event);
  const waiting = new Map<string, number>([['wss://search.test', 5], ['wss://nos.lol', 5]]);
  const fetched: string[][] = [];
  const h = harness({ fixtures: [], publishGeneral: true, db: first.db, vault: first.vault, indexKey: first.indexKey,
    fetchOwn: async (filter) => { fetched.push(filter.authors ?? []); return held.filter((e) => filter.authors!.includes(e.pubkey) && filter.kinds!.includes(e.kind)); },
    pendingFor: (relay) => waiting.get(relay) ?? 0 });
  await h.indexer.tick();
  assert.deepEqual(fetched.flat(), [first.indexPubkey], 'only the index key\'s events');
  const backfill = h.sent.filter((s) => s.relays);
  const to = (relay: string) => backfill.filter((s) => s.relays!.includes(relay)).map((s) => s.event.kind).sort((a, b) => a - b);
  assert.deepEqual(to('wss://search.test'), [0, 3, 10002], 'the directory is held');
  assert.deepEqual(to('wss://purplepag.es'), [0, 3, 10002]);
  assert.deepEqual(to('wss://nos.lol'), [0, 3, 10002]);
  assert.deepEqual(to('wss://lists.test'), []);
  h.clock.now = NOW + 30;
  await h.indexer.tick();
  assert.equal(h.dir.fact('outside_backfill wss://purplepag.es'), '1', 'drained at once');
  assert.equal(h.dir.fact('outside_backfill wss://search.test'), null, 'not done while its events wait');
  waiting.clear();
  h.clock.now = NOW + 60;
  await h.indexer.tick();
  for (const relay of ['wss://search.test', 'wss://purplepag.es', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io']) {
    assert.equal(h.dir.fact(`outside_backfill ${relay}`), '1', relay);
  }
  const before = h.sent.filter((s) => s.relays).length;
  h.clock.now = NOW + 90;
  await h.indexer.tick();
  assert.equal(h.sent.filter((s) => s.relays).length, before, 'sent once');

  // A relay added later gets the backfill alone.
  const later = harness({ fixtures: [], publishGeneral: true, db: first.db, vault: first.vault, indexKey: first.indexKey, generalRelays: 'wss://nos.lol,wss://new.test',
    fetchOwn: async (filter) => held.filter((e) => filter.authors!.includes(e.pubkey) && filter.kinds!.includes(e.kind)), pendingFor: () => 0 });
  later.clock.now = NOW + 120;
  await later.indexer.tick();
  const targets = new Set(later.sent.filter((s) => s.relays).flatMap((s) => s.relays!));
  assert.deepEqual([...targets], ['wss://new.test']);
});

test('a calendar is polled again only when it is due', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await h.indexer.tick();
  // An event starts within 48 hours, so the next poll is an hour away.
  h.clock.now = NOW + 30 * 60;
  assert.deepEqual((await h.indexer.tick()).polled, []);
  h.clock.now = NOW + H + 1;
  assert.deepEqual((await h.indexer.tick()).polled, ['meetup:pythonsd']);
});

test('a failing feed does not stop the others, and backs off', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics', 'luma-calendar-craftnook.ics'], failing: ['meetup-pythonsd.ics'] });
  const report = await h.indexer.tick();
  assert.deepEqual(report.polled.sort(), ['luma:cal-BvuRd9eaZnDGBwy', 'meetup:pythonsd']);
  assert.deepEqual(report.failed, ['meetup:pythonsd']);
  assert.equal(h.db.pollState('meetup:pythonsd').failures, 1);
  assert.ok(h.events.countByCalendar('luma:cal-BvuRd9eaZnDGBwy') > 0);
});

test('retired and do-not-index calendars are never polled', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics', 'luma-calendar-craftnook.ics'] });
  h.dir.retire('meetup:pythonsd', 'organizer request', NOW);
  h.dir.block('luma:cal-BvuRd9eaZnDGBwy', 'organizer request', NOW);
  assert.deepEqual((await h.indexer.tick()).polled, []);
  assert.deepEqual(h.fetched, []);
});

test('an approved removal withdraws the calendar\'s items at once, republishes its entry as removed, and retires it', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'], rsvps: new Set(['anything']) });
  await h.indexer.tick();
  const items = h.sent.filter((s) => s.audience === 'own' && isItem(s.event)).map((s) => s.event.tags.find((t) => t[0] === 'd')![1]);
  assert.equal(items.length, 4);
  const { id } = h.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
  h.queues.resolveRemoval(id, 'approved', NOW);
  const before = h.sent.length;
  h.clock.now = NOW + 60;
  const report = await h.indexer.tick();
  assert.deepEqual(report.removed, ['meetup:pythonsd']);
  const after = h.sent.slice(before).map((s) => s.event);
  assert.ok(after.every((e) => e.pubkey === h.indexPubkey));
  const withdrawn = after.filter((e) => e.kind === 5).map((e) => e.tags.find((t) => t[0] === 'a')![1]!.split(':')[2]);
  assert.deepEqual(withdrawn.sort(), [...items].sort(), 'every item is withdrawn, RSVPs or not');
  const entry = after.find((e) => e.kind === 39999 && !isItem(e))!;
  assert.deepEqual(entry.tags.at(-1), ['removed', 'organizer request']);
  assert.equal(h.dir.get('meetup:pythonsd')!.removed, 'organizer request');
  assert.ok(h.dir.doNotIndex('meetup:pythonsd'));
  assert.equal(h.events.countByCalendar('meetup:pythonsd'), 0);
  assert.equal(h.queues.removal(id)!.status, 'done');
  h.clock.now = NOW + 7 * H;
  assert.deepEqual((await h.indexer.tick()).polled, []);
});

test('a remove token placed in the feed marks the request verified', async () => {
  const texts: Record<string, string> = {};
  const h = harness({ fixtures: ['meetup-pythonsd.ics'], texts });
  const { id, token } = h.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
  await h.indexer.tick();
  assert.equal(h.queues.removal(id)!.verifiedAt, null);
  // The organizer adds the token to an event's title.
  texts['meetup-pythonsd.ics'] = readFixture('meetup-pythonsd.ics').replace('SUMMARY:SDPy Monthly Meetup', `SUMMARY:SDPy Monthly Meetup ${token}`);
  h.clock.now = NOW + H + 1;
  await h.indexer.tick();
  assert.equal(h.queues.removal(id)!.verifiedAt, NOW + H + 1);
  assert.equal(h.queues.removal(id)!.status, 'pending', 'a maintainer still decides');
});

test('co-hosted calendars publish the shared event once', async () => {
  const early = Date.UTC(2026, 8, 5, 18) / 1000;
  const h = harness({ fixtures: ['luma-calendar-craftnook.ics', 'luma-calendar-journaling.ics'] });
  h.clock.now = early;
  await h.indexer.tick();
  h.clock.now = early + 2 * 86400;
  await h.indexer.tick();
  const shared = h.events.search({ from: early, to: early + 30 * 86400, q: 'equinox' });
  assert.equal(shared.length, 2, 'both calendars hold it');
  const listed = h.sent.filter((s) => s.audience === 'own' && isItem(s.event) && /equinox/i.test(s.event.tags.find((t) => t[0] === 'title')![1]!));
  assert.equal(new Set(listed.map((s) => s.event.tags.find((t) => t[0] === 'd')![1])).size, 1, 'it is listed once');
  const row = h.events.search({ from: early, to: early + 30 * 86400, q: 'equinox' });
  assert.ok(row.some((r) => r.canonical !== null), 'the other calendar\'s copy names the record it yields to');
});

test('a dump of the directory is written once a day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idx-'));
  try {
    const h = harness({ fixtures: ['meetup-pythonsd.ics'], dataDir: dir });
    await h.indexer.tick();
    assert.ok(existsSync(join(dir, 'dump', 'index.db')));
    assert.equal(h.dir.fact('dump_at'), String(NOW));
    h.clock.now = NOW + H * 2;
    await h.indexer.tick();
    assert.equal(h.dir.fact('dump_at'), String(NOW));
    h.clock.now = NOW + 86400 + 1;
    await h.indexer.tick();
    assert.equal(h.dir.fact('dump_at'), String(NOW + 86400 + 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kind 10002 names the general relays only when the index publishes to them', async () => {
  for (const publishGeneral of [false, true]) {
    const h = harness({ fixtures: ['meetup-pythonsd.ics'], publishGeneral });
    await h.indexer.tick();
    const lists = h.sent.filter((s) => s.audience === 'own' && s.event.kind === 10002).map((s) => s.event);
    assert.equal(lists.length, 1, 'the index key\'s');
    for (const list of lists) {
      const expected = [['r', 'wss://relay.eventindex.space'], ...(publishGeneral ? ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io'].map((r) => ['r', r, 'write']) : [])];
      assert.deepEqual(list.tags, expected, `general relays ${publishGeneral ? 'on' : 'off'}`);
    }
  }
});

test('the relay allowlist names the index key, and organizers only when the relay hosts them', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'allow-'));
  try {
    const file = join(dataDir, 'relay-allowlist.json');
    const h = harness({ fixtures: ['meetup-pythonsd.ics'], dataDir });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { index: h.indexPubkey, hosted: [] }, 'written as the service starts');
    await h.indexer.tick();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { index: h.indexPubkey, hosted: [] });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the directory stays on the index\'s relay until publishing it outside is on, then goes out once', async () => {
  const first = harness({ fixtures: ['meetup-pythonsd.ics'], publishGeneral: true });
  await first.indexer.tick();
  assert.deepEqual(outside(first.sent, 'lists'), []);
  assert.ok(!first.sent.some((s) => s.audience !== 'own' && (s.event.kind === 39998 || s.event.kind === 39999)));
  assert.ok(first.sent.some((s) => s.audience === 'general' && s.event.kind === 0), 'the index key\'s profile goes out');
  const held = first.sent.filter((s) => s.audience === 'own').map((s) => s.event);
  const h = harness({ fixtures: [], publishGeneral: true, publishDirectory: true, db: first.db, vault: first.vault, indexKey: first.indexKey,
    fetchOwn: async (filter) => held.filter((e) => filter.authors!.includes(e.pubkey) && filter.kinds!.includes(e.kind)), pendingFor: () => 0 });
  for (const relay of ['wss://search.test', 'wss://purplepag.es', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io']) first.dir.setFact(`outside_backfill ${relay}`, '1');
  h.clock.now = NOW + 60;
  await h.indexer.tick();
  const backfill = h.sent.filter((s) => s.relays);
  assert.deepEqual(backfill.filter((s) => s.relays!.includes('wss://lists.test')).map((s) => s.event.kind).sort(), [39999, 39999, 39999, 39999, 39999]);
  assert.deepEqual(backfill.filter((s) => s.relays!.includes('wss://search.test')).map((s) => s.event.kind).sort(), [39999, 39999, 39999, 39999, 39999], 'only the directory\'s entry and items are backfilled');
  h.clock.now = NOW + 90;
  await h.indexer.tick();
  assert.equal(h.dir.fact('outside_backfill_directory wss://lists.test'), '1');
  assert.equal(h.dir.fact('outside_backfill_directory wss://search.test'), '1');
});

const HEADER = `39998:${'ab'.repeat(32)}:event-calendars`;

test('entries name the maintainer\'s list header, in its shape', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'], header: HEADER });
  await h.indexer.tick();
  const entry = h.sent.find((s) => s.audience === 'own' && s.event.kind === 39999 && !isItem(s.event))!.event;
  assert.deepEqual(entry.tags.map((t) => t[0]), ['d', 'z', 'name', 'role', 'index-name', 'feed', 'source', 'meetup-group', 't']);
  assert.deepEqual(entry.tags[1], ['z', HEADER]);
  assert.deepEqual(entry.tags.find((t) => t[0] === 'index-name'), ['index-name', 'meetup-pythonsd']);
});

test('the index\'s own calendars header is retired once, on its relay only', async () => {
  const first = harness({ fixtures: ['meetup-pythonsd.ics'] });
  // A header the index key published before it became a curator.
  first.db.markPublished({ pubkey: first.indexPubkey, kind: 39998, d: 'event-calendars', hash: 'h', eventId: 'f'.repeat(64), createdAt: NOW - 3600, start: NOW - 3600 });
  const h = harness({ fixtures: [], publishGeneral: true, publishDirectory: true, header: HEADER, db: first.db, vault: first.vault, indexKey: first.indexKey });
  await h.indexer.tick();
  const deletions = h.sent.filter((s) => s.event.kind === 5 && s.event.pubkey === h.indexPubkey);
  assert.deepEqual(deletions.map((s) => s.audience), ['own']);
  assert.deepEqual(deletions[0]!.event.tags, [['e', 'f'.repeat(64)], ['a', `39998:${h.indexPubkey}:event-calendars`], ['k', '39998']]);
  assert.equal(h.db.projection(h.indexPubkey, 39998, 'event-calendars')!.status, 'deleted');
  h.clock.now = NOW + 60;
  await h.indexer.tick();
  assert.equal(h.sent.filter((s) => s.event.kind === 5).length, 1, 'once');
});

test('the curator\'s relay list names the list relays once the directory goes outside', async () => {
  const held = harness({ fixtures: [], publishGeneral: true });
  await held.indexer.tick();
  const without = held.sent.find((s) => s.audience === 'own' && s.event.kind === 10002)!.event;
  assert.ok(!without.tags.some((t) => t[1] === 'wss://lists.test'));
  const out = harness({ fixtures: [], publishGeneral: true, publishDirectory: true });
  await out.indexer.tick();
  const list = out.sent.find((s) => s.audience === 'own' && s.event.kind === 10002)!.event;
  assert.deepEqual(list.tags[0], ['r', 'wss://relay.eventindex.space']);
  assert.ok(list.tags.some((t) => t[0] === 'r' && t[1] === 'wss://lists.test' && t[2] === 'write'));
});

test('a calendar just approved is polled and published at the next tick, before every other due calendar', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics', 'luma-calendar-craftnook.ics', 'mobilizon-lyontechhub.ics'], maxPollsPerTick: 1, extraFeeds: ['google-python-events.ics'] });
  for (let i = 0; i < 3; i += 1) await h.indexer.tick();
  // A day later every calendar is due again, and one more has just been approved.
  h.clock.now = NOW + 86400;
  h.dir.add(entryFor('google-python-events.ics', { addedAt: h.clock.now, foundVia: 'submission' }));
  const before = h.sent.length;
  const report = await h.indexer.tick();
  const d = identify(feedUrlFor('google-python-events.ics')).d;
  assert.deepEqual(report.polled, [d]);
  assert.ok(h.sent.slice(before).some((s) => s.audience === 'own' && isItem(s.event) && s.event.tags.some((t) => t[0] === 'calendar' && t[1]!.endsWith(`:${d}`))), 'its events went out');
});
