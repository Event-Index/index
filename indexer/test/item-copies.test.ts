// An event item names the aggregator copies matched to its event, so a
// client showing both NIP-52 events and items can hide the copies.

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

const SEARCH = 'wss://search.test';
const GENERAL = 'wss://general.test';
const HEADER = `39998:${'ab'.repeat(32)}:events`;
const FEED = identify(feedUrlFor('meetup-pythonsd.ics'));
// The feed's SDPy Monthly Meetup.
const MEETUP = { title: 'SDPy Monthly Meetup', start: 1792720800 };

function harness(aggregators: string[]) {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const events = eventStore(db);
  const indexKey = generateSecretKey();
  const held: Record<string, VerifiedEvent[]> = { [SEARCH]: [], [GENERAL]: [] };
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const clock = { now: NOW };
  const indexer = createIndexer({
    db, dir, queues: queueStore(db), events, vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey,
    settings: loadSettings({
      EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: 'ws://own.test', EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER,
      EVENTINDEX_INGEST_NOSTR: '1', EVENTINDEX_INGEST_RELAYS: GENERAL, EVENTINDEX_INGEST_SEARCH_RELAYS: SEARCH, EVENTINDEX_PROFILE_RELAYS: 'none',
    }),
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
    aggregators: new Set(aggregators),
    log: () => {},
  });
  dir.add({ ...FEED, name: null, description: null, image: null, location: 'San Diego, US', g: '9mud', foundVia: 'maintainer', addedAt: NOW });
  return { db, dir, events, indexer, held, sent, clock, indexPubkey: getPublicKey(indexKey) };
}

function publisher() {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const sign = (kind: number, tags: string[][], at = NOW - 600) => finalizeEvent({ kind, tags, content: '', created_at: at }, key);
  const event = (d: string, title: string, start: number, at = NOW - 600) => sign(31923, [['d', d], ['title', title], ['start', String(start)]], at);
  return { pubkey, sign, event };
}

const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === HEADER);
const meetupRow = (h: ReturnType<typeof harness>) => h.events.byCalendar(FEED.d, NOW, NOW + 30 * 86400).find((r) => r.title === MEETUP.title)!;
const itemOf = (h: ReturnType<typeof harness>, d: string) => h.sent.filter((x) => x.audience === 'own' && isItem(x.event) && x.event.tags.find((t) => t[0] === 'd')?.[1] === d).at(-1)?.event;
const copyTags = (e: VerifiedEvent) => e.tags.filter((t) => t[0] === 'a' && t[3] === 'copy');

test('an item names the aggregator copy matched to its event, with where the copy was read, until the match goes', async () => {
  const club = publisher();
  const h = harness([club.pubkey]);
  const copy = club.event('club-sdpy', MEETUP.title, MEETUP.start);
  h.held[SEARCH]!.push(copy, club.event('club-other', 'Bitcoin & Coffee', MEETUP.start));
  await h.indexer.tick();
  const row = meetupRow(h);
  const item = itemOf(h, row.id)!;
  assert.deepEqual(copyTags(item), [['a', `31923:${club.pubkey}:club-sdpy`, SEARCH, 'copy']], 'the matched copy only');
  assert.equal(item.tags.find((t) => t[0] === 'calendar')![1], `39999:${h.indexPubkey}:${FEED.d}`, 'the calendar field is unaffected');
  const versions = h.sent.filter((x) => x.audience === 'own' && isItem(x.event) && x.event.tags.find((t) => t[0] === 'd')?.[1] === row.id).length;

  // The copy is deleted by its aggregator: the match goes, and the item is republished without it.
  h.held[SEARCH]!.push(club.sign(5, [['e', copy.id], ['k', '31923']], NOW + 30));
  h.clock.now = NOW + 700;
  await h.indexer.tick();
  const after = itemOf(h, row.id)!;
  assert.notEqual(after.id, item.id);
  assert.deepEqual(copyTags(after), []);
  assert.ok(after.created_at > item.created_at);
  assert.equal(h.sent.filter((x) => x.audience === 'own' && isItem(x.event) && x.event.tags.find((t) => t[0] === 'd')?.[1] === row.id).length, versions + 1);
});

test('a copy matched later republishes the item; at most 20 copies are named, the newest', async () => {
  const club = publisher();
  const h = harness([club.pubkey]);
  await h.indexer.tick();
  const row = meetupRow(h);
  const first = itemOf(h, row.id)!;
  assert.deepEqual(copyTags(first), []);

  for (let i = 0; i < 25; i += 1) h.held[SEARCH]!.push(club.event(`dup-${String(i).padStart(2, '0')}`, MEETUP.title, MEETUP.start + i * 60, NOW + 100 + i));
  h.clock.now = NOW + 700;
  await h.indexer.tick();
  const item = itemOf(h, row.id)!;
  assert.notEqual(item.id, first.id, 'republished');
  const tags = copyTags(item);
  assert.equal(tags.length, 20);
  assert.deepEqual(tags.map((t) => t[1]), Array.from({ length: 20 }, (_, i) => `31923:${club.pubkey}:dup-${String(24 - i).padStart(2, '0')}`), 'newest first');
  assert.ok(item.tags.length <= 2000);
});

test('only aggregators\' copies are named; an event whose original is its organizer\'s own has no item, as before', async () => {
  const org = publisher();
  const other = publisher();
  const h = harness([]);
  // A calendar publishing the same event that is not an aggregator: the organizer's own.
  h.held[SEARCH]!.push(org.event('sdpy-own', MEETUP.title, MEETUP.start));
  h.held[SEARCH]!.push(other.event('unrelated', 'Something else', MEETUP.start));
  await h.indexer.tick();
  h.clock.now = NOW + 700;
  await h.indexer.tick();
  const row = meetupRow(h);
  assert.equal(row.canonical, h.events.byCalendar(nativeD(org.pubkey), NOW, NOW + 30 * 86400)[0]!.id);
  assert.equal(itemOf(h, row.id), undefined, 'no item for a copy of the organizer\'s own event');
  for (const x of h.sent.filter((s) => isItem(s.event))) assert.deepEqual(copyTags(x.event), []);
});
