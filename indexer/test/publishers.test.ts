// The poll service reading every public NIP-52 event and listing each
// publisher in the directory on its own, filed by the index key as curator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify, nativeD } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { loadAggregators } from '../src/native/publishers.ts';

const SEARCH = 'wss://search.test';
const GENERAL = 'wss://general.test';
const PROFILES = 'wss://profiles.test';

function harness(options: { outsideNative?: boolean; aggregators?: string[]; retired?: string[] } = {}) {
  const db = openIndexDb(':memory:');
  if (options.retired) {
    // Calendar keys the index once held, as their retirement recorded them.
    db.raw.exec('CREATE TABLE retirement (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, calendar_d TEXT NOT NULL, kind INTEGER NOT NULL, event TEXT NOT NULL)');
    for (const [i, pubkey] of options.retired.entries()) db.raw.prepare('INSERT INTO retirement VALUES (?, ?, ?, 0, ?)').run(String(i), pubkey, `luma:cal-${i}`, '{}');
  }
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const events = eventStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const held: Record<string, VerifiedEvent[]> = { [SEARCH]: [], [GENERAL]: [], [PROFILES]: [], 'ws://own.test': [] };
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const logs: string[] = [];
  const clock = { now: NOW };
  const settings = {
    ...loadSettings({
      EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: 'ws://own.test', EVENTINDEX_GENERAL_RELAYS: GENERAL, EVENTINDEX_PROFILE_RELAYS: PROFILES,
      EVENTINDEX_SEARCH_RELAYS: SEARCH, EVENTINDEX_LIST_RELAYS: 'wss://lists.test',
      EVENTINDEX_INGEST_NOSTR: '1', EVENTINDEX_INGEST_RELAYS: GENERAL, EVENTINDEX_INGEST_SEARCH_RELAYS: SEARCH,
      ...(options.outsideNative ? { EVENTINDEX_PUBLISH_NOSTR_ENTRIES_OUTSIDE: '1' } : {}),
    }),
    publishToGeneralRelays: true,
    publishDirectoryOutside: true,
  };
  const indexer = createIndexer({
    db, dir, queues, events, vault, indexKey, settings,
    now: () => clock.now,
    fetch: async (url) => ({ status: 'ok', text: readFixture('meetup-pythonsd.ics'), etag: null, lastModified: null, finalUrl: url }),
    publisher: { publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))), rsvps: async () => new Set(), close: () => {} },
    reader: {
      async query(urls: string[], filter: Filter) {
        const answered = urls.filter((u) => held[u]);
        const { search: _, ...plain } = filter;
        const found = answered.flatMap((relay) => held[relay]!.filter((e) => matchFilter(plain as Filter, e))
          .sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit ?? 500).map((event) => ({ event, relay })));
        return { answered, found };
      },
    },
    relayAllowed: async () => true,
    ...(options.aggregators ? { aggregators: new Set(options.aggregators) } : {}),
    log: (line) => logs.push(line),
  });
  return { db, dir, events, vault, indexer, held, sent, logs, clock, indexPubkey: getPublicKey(indexKey) };
}

function publisher() {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const sign = (kind: number, tags: string[][], content = '', at = NOW - 600) => finalizeEvent({ kind, tags, content, created_at: at }, key);
  const event = (d: string, title: string, start = NOW + 3 * 86400, extra: string[][] = []) =>
    sign(31923, [['d', d], ['title', title], ['start', String(start)], ...extra]);
  return { key, pubkey, sign, event };
}

test('every publisher of NIP-52 events is listed, named from its profile, and its events served', async () => {
  const h = harness();
  const a = publisher();
  const b = publisher();
  h.held[SEARCH]!.push(a.event('oct', 'October meetup'), a.event('nov', 'November meetup', NOW + 20 * 86400));
  h.held[GENERAL]!.push(b.event('fest', 'Harvest festival'));
  h.held[PROFILES]!.push(a.sign(0, [], JSON.stringify({ display_name: 'Lakeside Bitcoin Club', about: 'Monthly meetups.', website: 'https://lakeside.example.org' })));
  await h.indexer.tick();
  await h.indexer.tick();
  const entry = h.dir.get(nativeD(a.pubkey))!;
  assert.deepEqual([entry.mode, entry.owner, entry.role, entry.source, entry.foundVia], ['own', a.pubkey, 'calendar', 'nostr', 'ingest']);
  assert.equal(entry.name, 'Lakeside Bitcoin Club');
  assert.equal(entry.pageUrl, 'https://lakeside.example.org');
  assert.deepEqual(h.events.byCalendar(entry.d, NOW, NOW + 30 * 86400).map((r) => r.title), ['October meetup', 'November meetup']);
  const unnamed = h.dir.get(nativeD(b.pubkey))!;
  assert.match(unnamed.name!, /^npub1[0-9a-z]{8}…[0-9a-z]{6}$/, 'a publisher with no profile is named by its key');
  assert.equal(h.sent.filter((s) => s.event.pubkey !== h.indexPubkey).length, 0, 'the index signs and sends none of their events');
  const follows = h.sent.filter((s) => s.event.kind === 3).at(-1)!.event;
  assert.ok(!follows.tags.some((t) => t[1] === a.pubkey), 'a listed publisher is not followed');
});

test('their directory entries stay on the index\'s relay until the operator sends them outside', async () => {
  const off = harness();
  const a = publisher();
  off.held[SEARCH]!.push(a.event('oct', 'October meetup'));
  await off.indexer.tick();
  const entries = off.sent.filter((s) => s.event.kind === 39999 && s.event.tags[0]![1] === nativeD(a.pubkey));
  assert.ok(entries.length > 0 && entries.every((s) => s.audience === 'own'));
  const on = harness({ outsideNative: true });
  on.held[SEARCH]!.push(a.event('oct', 'October meetup'));
  await on.indexer.tick();
  assert.ok(on.sent.some((s) => s.event.kind === 39999 && s.event.tags[0]![1] === nativeD(a.pubkey) && s.audience === 'lists'));
});

test('an aggregator is listed as one, with its events kept and attributed to it', async () => {
  const club = publisher();
  const h = harness({ aggregators: [club.pubkey] });
  h.held[SEARCH]!.push(club.event('x', 'Bitcoin & Coffee'));
  await h.indexer.tick();
  const entry = h.dir.get(nativeD(club.pubkey))!;
  assert.equal(entry.role, 'aggregator');
  const listed = h.sent.filter((s) => s.event.kind === 39999 && s.event.tags[0]![1] === entry.d).at(-1)!.event;
  assert.deepEqual(listed.tags.filter((t) => t[0] === 'role' || t[0] === 'p'), [['role', 'aggregator'], ['p', club.pubkey]]);
  assert.equal(h.events.byCalendar(entry.d, NOW, NOW + 30 * 86400).length, 1);
});

test('nothing the index signs or once signed, nothing from a key whose secret is public, and nothing from a removed publisher is listed', async () => {
  const retired = publisher();
  const h = harness({ retired: [retired.pubkey] });
  await h.indexer.tick();
  // A calendar key the index once held: what it signed lingers on relays that ignore deletions.
  h.held[SEARCH]!.push(retired.event('left', 'An old mirrored event'));
  const someone = publisher();
  h.held[SEARCH]!.push(someone.event('copy', 'A copy', NOW + 86400, [['z', `39998:${h.indexPubkey}:events`]]));
  const one = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  h.held[SEARCH]!.push(finalizeEvent({ kind: 31923, tags: [['d', 'x'], ['title', 'Anyone could sign this'], ['start', String(NOW + 86400)]], content: '', created_at: NOW - 60 },
    new Uint8Array(Buffer.from('00'.repeat(31) + '01', 'hex'))));
  const gone = publisher();
  h.dir.block(nativeD(gone.pubkey), 'organizer request', NOW);
  h.held[SEARCH]!.push(gone.event('g', 'Gone'));
  h.clock.now = NOW + 60;
  await h.indexer.tick();
  assert.equal(h.dir.get(nativeD(retired.pubkey)), null);
  assert.ok(h.dir.doNotIndex(nativeD(retired.pubkey)));
  assert.equal(h.dir.get(nativeD(someone.pubkey)), null);
  assert.equal(h.dir.get(nativeD(one)), null);
  assert.equal(h.dir.get(nativeD(gone.pubkey)), null);
});

test('the events of an organizer who claimed a calendar are that calendar\'s, not a second entry\'s', async () => {
  const h = harness();
  const org = publisher();
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  h.dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: 'San Diego Python Users Group', description: null, image: null,
    location: null, g: null, foundVia: 'maintainer', addedAt: NOW, mode: 'own', owner: org.pubkey });
  h.held[SEARCH]!.push(org.event('own', 'Our own meetup'));
  await h.indexer.tick();
  assert.equal(h.dir.get(nativeD(org.pubkey)), null);
  assert.deepEqual(h.events.byCalendar(id.d, NOW, NOW + 30 * 86400).map((r) => r.title), ['Our own meetup']);
});

test('an event its publisher deletes leaves the index', async () => {
  const h = harness();
  const a = publisher();
  const oct = a.event('oct', 'October meetup');
  h.held[SEARCH]!.push(oct, a.event('nov', 'November meetup', NOW + 20 * 86400));
  await h.indexer.tick();
  h.held[SEARCH]!.push(a.sign(5, [['e', oct.id], ['k', '31923']], '', NOW + 30));
  h.clock.now = NOW + 3600;
  await h.indexer.tick();
  assert.deepEqual(h.events.byCalendar(nativeD(a.pubkey), NOW, NOW + 30 * 86400).map((r) => r.title), ['November meetup']);
});

test('an aggregator\'s copy points at the organizer\'s own event, in the events table and in its record, until the original is gone', async () => {
  const club = publisher();
  const org = publisher();
  const h = harness({ aggregators: [club.pubkey] });
  const start = NOW + 5 * 86400;
  const original = org.event('fb62', 'Fort Bitcoin #62 Panther City BBQ', start);
  h.held[SEARCH]!.push(original, club.event('co-1', 'Fort Bitcoin #62 Panther City BBQ', start, [['g', '9vff1rf1x']]),
    club.event('co-2', 'Bitcoin & Coffee', start));
  await h.indexer.tick();
  const copy = h.events.byCalendar(nativeD(club.pubkey), NOW, NOW + 30 * 86400).find((r) => r.title.startsWith('Fort'))!;
  const own = h.events.byCalendar(nativeD(org.pubkey), NOW, NOW + 30 * 86400)[0]!;
  assert.equal(copy.canonical, own.id);
  assert.equal(own.canonical, null);
  assert.equal(h.events.byCalendar(nativeD(club.pubkey), NOW, NOW + 30 * 86400).find((r) => r.title.startsWith('Bitcoin'))!.canonical, null);
  assert.match(h.db.record(copy.recordId)!.ics.replace(/\r\n /g, ''), new RegExp(`X-EVENTINDEX-CANONICAL:https://api.eventindex.space/api/1.0/events/byid/${own.id}`));

  h.held[SEARCH]!.push(org.sign(5, [['e', original.id], ['k', '31923']], '', NOW + 30));
  h.clock.now = NOW + 3600;
  await h.indexer.tick();
  const after = h.events.byCalendar(nativeD(club.pubkey), NOW, NOW + 30 * 86400).find((r) => r.title.startsWith('Fort'))!;
  assert.equal(after.canonical, null, 'with the original deleted, the copy stands on its own');
  assert.ok(!h.db.record(after.recordId)!.ics.includes('X-EVENTINDEX-CANONICAL'));
});

test('a mirrored feed\'s event yields to the organizer\'s own on nostr: the copy names it as its original', async () => {
  const h = harness();
  const org = publisher();
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  h.dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
    location: null, g: null, foundVia: 'maintainer', addedAt: NOW });
  // The meetup's own event on nostr: the same title and start as in the feed.
  h.held[SEARCH]!.push(org.event('sdpy-oct', 'SDPy Monthly Meetup', 1792720800));
  await h.indexer.tick();
  h.clock.now = NOW + 60;
  await h.indexer.tick();
  const mirrored = h.events.byCalendar(id.d, NOW, NOW + 30 * 86400).find((r) => r.title === 'SDPy Monthly Meetup')!;
  const own = h.events.byCalendar(nativeD(org.pubkey), NOW, NOW + 30 * 86400)[0]!;
  assert.equal(mirrored.canonical, own.id);
});

test('a publisher listed from a pasted link is treated as one the index found and kept home; one proven by its key goes out', async () => {
  const h = harness();
  const pasted = publisher();
  const proven = publisher();
  for (const [p, via] of [[pasted, 'submission'], [proven, 'owner']] as const) {
    h.dir.add({ d: nativeD(p.pubkey), role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: via, description: null, image: null,
      location: null, g: null, foundVia: via, addedAt: NOW, mode: 'own', owner: p.pubkey });
    h.held[SEARCH]!.push(p.event('e', `Event of ${via}`));
  }
  await h.indexer.tick();
  const outside = (pubkey: string) => h.sent.filter((s) => s.event.kind === 39999 && s.event.tags[0]![1] === nativeD(pubkey) && s.audience !== 'own').length;
  assert.equal(outside(pasted.pubkey), 0);
  assert.ok(outside(proven.pubkey) > 0);
});

const entriesOf = (h: ReturnType<typeof harness>, pubkey: string) =>
  h.sent.filter((s) => (s.event.kind === 39999 && s.event.tags[0]![1] === nativeD(pubkey)) || (s.event.kind === 5 && s.event.tags.some((t) => t[1]?.endsWith(nativeD(pubkey)))));

test('a publisher with no upcoming events is kept and served, without a directory entry', async () => {
  const h = harness({ outsideNative: true });
  const past = publisher();
  h.held[GENERAL]!.push(past.event('spring', 'Spring meetup', NOW - 30 * 86400), past.sign(0, [], JSON.stringify({ name: 'Quiet Club' })));
  await h.indexer.tick();
  await h.indexer.tick();
  const entry = h.dir.get(nativeD(past.pubkey))!;
  assert.equal(entry.listed, false);
  assert.deepEqual(h.events.byCalendar(entry.d, NOW - 60 * 86400, NOW).map((r) => r.title), ['Spring meetup']);
  assert.equal(h.db.recordsOf(entry.d).length, 1);
  assert.deepEqual(entriesOf(h, past.pubkey), [], 'no directory entry is published');
  assert.ok(!h.dir.list().some((e) => e.d === entry.d));
});

test('a publisher is listed once it has an upcoming event, and stays listed once its events pass', async () => {
  const h = harness({ outsideNative: true });
  const p = publisher();
  h.held[GENERAL]!.push(p.event('spring', 'Spring meetup', NOW - 30 * 86400));
  await h.indexer.tick();
  assert.equal(h.dir.get(nativeD(p.pubkey))!.listed, false);
  h.held[GENERAL]!.push(p.event('oct', 'October meetup', NOW + 3 * 86400));
  h.clock.now += 600;
  await h.indexer.tick();
  assert.equal(h.dir.get(nativeD(p.pubkey))!.listed, true);
  assert.deepEqual([...new Set(entriesOf(h, p.pubkey).map((s) => s.audience))].sort(), ['lists', 'own', 'search']);
  assert.ok(h.logs.some((l) => l === `listed ${nativeD(p.pubkey)}`), h.logs.join('\n'));
  const before = entriesOf(h, p.pubkey).length;
  h.clock.now += 10 * 86400;
  await h.indexer.tick();
  assert.equal(h.dir.get(nativeD(p.pubkey))!.listed, true);
  assert.ok(h.dir.list().some((e) => e.d === nativeD(p.pubkey)));
  assert.equal(entriesOf(h, p.pubkey).length, before, 'its entry is neither withdrawn nor sent again');
});

test('the exact count of nostr publishers\' entries going outside is logged before they are sent', async () => {
  const h = harness({ outsideNative: true });
  const [a, b, quiet] = [publisher(), publisher(), publisher()];
  h.held[SEARCH]!.push(a.event('x', 'Meetup A'), b.event('y', 'Meetup B'), quiet.event('z', 'Old meetup', NOW - 86400));
  await h.indexer.tick();
  const line = h.logs.findIndex((l) => l === 'directory: sending 2 entries of nostr publishers to the list and search relays (2 listed, 1 kept without an entry)');
  assert.ok(line >= 0, h.logs.join('\n'));
  h.clock.now += 60;
  await h.indexer.tick();
  assert.equal(h.logs.filter((l) => l.startsWith('directory: sending')).length, 1, 'only when there are some to send');
});

test('the aggregators list names each key once, as hex, with what it publishes', () => {
  const list = JSON.parse(readFileSync(new URL('../../seeds/nostr-aggregators.json', import.meta.url), 'utf8')) as { aggregators: Array<{ pubkey: string; name: string; note: string }> };
  for (const a of list.aggregators) {
    assert.match(a.pubkey, /^[0-9a-f]{64}$/);
    assert.ok(a.name && a.note, a.pubkey);
  }
  assert.equal(loadAggregators().size, list.aggregators.length, 'no key twice');
});
