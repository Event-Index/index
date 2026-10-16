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
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const H = 3600;

function entryFor(fixture: string, extra: Partial<Entry> = {}): Entry {
  const id = identify(feedUrlFor(fixture));
  return { d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
    location: null, g: null, foundVia: null, addedAt: NOW - 86400, ...extra };
}

function harness(options: { fixtures: string[]; texts?: Record<string, string>; failing?: string[]; publishGeneral?: boolean; rsvps?: Set<string>; dataDir?: string;
  onPublish?: (list: VerifiedEvent[], audience: Audience) => void; db?: ReturnType<typeof openIndexDb>; vault?: ReturnType<typeof openVault>; indexKey?: Uint8Array }) {
  const db = options.db ?? openIndexDb(':memory:');
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const events = eventStore(db);
  const vault = options.vault ?? openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = options.indexKey ?? generateSecretKey();
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const fetched: string[] = [];
  const clock = { now: NOW };
  const urls = new Map(options.fixtures.map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const settings = { ...loadSettings({ EVENTINDEX_DATA_DIR: options.dataDir ?? '/nonexistent' }), publishToGeneralRelays: options.publishGeneral ?? false };
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
      publish: async (list, audience) => {
        options.onPublish?.(list, audience);
        sent.push(...list.map((event) => ({ audience, event })));
      },
      rsvps: async () => options.rsvps ?? new Set(),
      close: () => {},
    },
    log: () => {},
  });
  for (const fixture of options.fixtures) if (!dir.get(entryFor(fixture).d)) dir.add(entryFor(fixture));
  return { db, dir, queues, events, vault, indexKey, indexPubkey: getPublicKey(indexKey), sent, fetched, clock, indexer };
}

const kindsOf = (sent: Array<{ event: VerifiedEvent }>, pubkey?: string) => sent.filter((s) => !pubkey || s.event.pubkey === pubkey).map((s) => s.event.kind).sort((a, b) => a - b);

test('a tick polls the due calendars, publishes their events, and stores their key, name and events', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'] });
  const report = await h.indexer.tick();
  assert.deepEqual(report.polled, ['meetup:pythonsd']);
  const entry = h.dir.get('meetup:pythonsd')!;
  assert.equal(entry.name, 'San Diego Python Users Group');
  assert.equal(entry.pubkey, h.vault.pubkeyFor('meetup:pythonsd'));
  assert.deepEqual(kindsOf(h.sent, entry.pubkey!), [0, 10002, 31923, 31923, 31923, 31923, 31924]);
  assert.ok(h.sent.every((s) => verifyEvent(s.event)));
  assert.equal(h.events.countByCalendar('meetup:pythonsd'), 4);
  assert.equal(h.dir.fact('index_pubkey'), h.indexPubkey);
});

test('the index key publishes its profile, both headers and the directory entries', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await h.indexer.tick();
  const own = h.sent.filter((s) => s.event.pubkey === h.indexPubkey).map((s) => s.event);
  assert.deepEqual(own.map((e) => e.kind).sort(), [0, 10002, 39998, 39998, 39999]);
  const entry = own.find((e) => e.kind === 39999)!;
  assert.deepEqual(entry.tags.find((t) => t[0] === 'p'), ['p', h.dir.get('meetup:pythonsd')!.pubkey]);
  assert.match(JSON.parse(own.find((e) => e.kind === 0)!.content).nip05, /^_@eventindex\.space$/);
  await h.indexer.tick();
  assert.equal(h.sent.filter((s) => s.event.pubkey === h.indexPubkey).length, own.length, 'unchanged events are not sent again');
});

test('nothing goes to general relays unless publishing to them is on', async () => {
  const off = harness({ fixtures: ['meetup-pythonsd.ics'] });
  await off.indexer.tick();
  assert.deepEqual([...new Set(off.sent.map((s) => s.audience))], ['own']);
  const on = harness({ fixtures: ['meetup-pythonsd.ics'], publishGeneral: true });
  await on.indexer.tick();
  assert.ok(on.sent.some((s) => s.audience === 'general' && s.event.kind === 31923));
  assert.ok(on.sent.some((s) => s.audience === 'lists' && s.event.kind === 39999));
  assert.ok(!on.sent.some((s) => s.audience === 'lists' && s.event.kind === 31923), 'list relays get list kinds only');
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

test('an approved removal deletes upcoming events even with RSVPs, marks the profile removed, and retires the entry', async () => {
  const h = harness({ fixtures: ['meetup-pythonsd.ics'], rsvps: new Set(['anything']) });
  await h.indexer.tick();
  const pubkey = h.dir.get('meetup:pythonsd')!.pubkey!;
  const { id } = h.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
  h.queues.resolveRemoval(id, 'approved', NOW);
  const before = h.sent.length;
  h.clock.now = NOW + 60;
  const report = await h.indexer.tick();
  assert.deepEqual(report.removed, ['meetup:pythonsd']);
  const after = h.sent.slice(before).map((s) => s.event);
  assert.equal(report.published, after.length, 'the report counts what the removal published');
  assert.equal(after.filter((e) => e.kind === 5 && e.pubkey === pubkey).length, 4);
  assert.equal(JSON.parse(after.find((e) => e.kind === 0 && e.pubkey === pubkey)!.content).about, 'No longer mirrored by Event Index at its organizer\'s request.');
  const entry = after.find((e) => e.kind === 39999)!;
  assert.deepEqual(entry.tags.at(-1), ['removed', 'organizer request']);
  assert.equal(h.dir.get('meetup:pythonsd')!.removed, 'organizer request');
  assert.equal(h.vault.pubkeyFor('meetup:pythonsd'), null, 'the calendar key is deleted once its last events are out');
  assert.equal(h.dir.get('meetup:pythonsd')!.pubkey, pubkey, 'the entry still names the key it had');
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
  const shared = nostrD('evt-ILpIInTRKRV1pnY@events.lu.ma');
  const craftnook = h.dir.get('luma:cal-BvuRd9eaZnDGBwy')!.pubkey!;
  const journaling = h.dir.get('luma:cal-f6iLyfD3TN5qUO2')!.pubkey!;
  const live = (pubkey: string) => h.db.projection(pubkey, 31923, shared)?.status === 'live';
  assert.notEqual(live(craftnook), live(journaling), 'exactly one calendar signs it');
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
    assert.equal(lists.length, 2, 'the index key\'s and the calendar key\'s');
    for (const list of lists) {
      const expected = [['r', 'wss://relay.eventindex.space'], ...(publishGeneral ? ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io'].map((r) => ['r', r, 'write']) : [])];
      assert.deepEqual(list.tags, expected, `general relays ${publishGeneral ? 'on' : 'off'}`);
    }
  }
});

test('the relay allowlist names every key before its first events go out, and removed keys once removed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'allow-'));
  try {
    const file = join(dataDir, 'relay-allowlist.json');
    const read = () => JSON.parse(readFileSync(file, 'utf8')) as { index: string; live: string[]; removed: string[] };
    const checked: number[] = [];
    const onPublish = (list: VerifiedEvent[], audience: Audience) => {
      if (audience !== 'own') return;
      const allow = read();
      for (const e of list) assert.ok(e.pubkey === allow.index || allow.live.includes(e.pubkey) || (allow.removed.includes(e.pubkey) && [0, 5].includes(e.kind)), `kind ${e.kind} by a key the allowlist lacks`);
      checked.push(list.length);
    };
    const h = harness({ fixtures: ['meetup-pythonsd.ics', 'luma-calendar-craftnook.ics'], dataDir, onPublish });
    assert.deepEqual(read(), { index: h.indexPubkey, live: [], removed: [] }, 'written as the service starts');
    await h.indexer.tick();
    assert.ok(checked.length >= 3);
    const python = h.dir.get('meetup:pythonsd')!.pubkey!;
    const craft = h.dir.get('luma:cal-BvuRd9eaZnDGBwy')!.pubkey!;
    assert.deepEqual(read().live.sort(), [python, craft].sort());

    const { id } = h.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
    h.queues.resolveRemoval(id, 'approved', NOW);
    h.clock.now = NOW + 60;
    await h.indexer.tick();
    assert.deepEqual(read(), { index: h.indexPubkey, live: [craft], removed: [python] });

    // A restart rebuilds the list from the directory.
    rmSync(file);
    const again = harness({ fixtures: [], dataDir, db: h.db, vault: h.vault, indexKey: h.indexKey });
    assert.deepEqual(read(), { index: again.indexPubkey, live: [craft], removed: [python] });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
