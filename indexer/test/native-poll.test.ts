// The poll service and a native calendar: an entry whose organizer publishes
// NIP-52 from their own key. The index signs nothing for it; it reads the
// organizer's events and serves them as records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { matchFilter } from 'nostr-tools/filter';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { nativeD } from '../src/directory/id.ts';
import type { RelayReader } from '../src/native/read.ts';
import { NOW } from './helpers.ts';

const organizerKey = generateSecretKey();
const organizer = getPublicKey(organizerKey);
const sign = (kind: number, tags: string[][], content = '', at = NOW - 3600): VerifiedEvent =>
  finalizeEvent({ kind, tags, content, created_at: at }, organizerKey);

const OWN = 'ws://own.test';

export function nativeHarness(held: Record<string, VerifiedEvent[]>) {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const events = eventStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const clock = { now: NOW };
  const reads: string[][] = [];
  const reader: RelayReader = {
    async query(urls: string[], filter: Filter) {
      reads.push(urls);
      const answered = urls.filter((u) => held[u]);
      return { answered, found: answered.flatMap((relay) => held[relay]!.filter((e) => matchFilter(filter, e)).map((event) => ({ event, relay }))) };
    },
  };
  const settings = loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: OWN, EVENTINDEX_GENERAL_RELAYS: 'wss://general.test', EVENTINDEX_PROFILE_RELAYS: 'none' });
  const indexer = createIndexer({
    db, dir, queues: queueStore(db), events, vault, indexKey, settings, reader,
    relayAllowed: async () => true,
    now: () => clock.now,
    fetch: async () => { throw new Error('a native calendar has no feed'); },
    publisher: { publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))), rsvps: async () => new Set(), close: () => {} },
    log: () => {},
  });
  return { db, dir, events, vault, indexer, indexPubkey: getPublicKey(indexKey), sent, clock, reads };
}

function fileNative(h: ReturnType<typeof nativeHarness>) {
  h.dir.add({ d: nativeD(organizer), role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: null, description: null, image: null,
    location: 'Chicago, US', g: 'dp3w', foundVia: 'owner', addedAt: NOW - 86400, mode: 'own', owner: organizer });
}

const meetup = sign(31923, [['d', 'oct'], ['title', 'October meetup'], ['start', String(NOW + 3 * 86400)], ['end', String(NOW + 3 * 86400 + 7200)], ['start_tzid', 'America/Chicago']], 'Monthly meetup.');
const fest = sign(31922, [['d', 'fest'], ['title', 'Harvest festival'], ['start', '2026-10-24']]);
const profile = sign(0, [], JSON.stringify({ name: 'lakeside', display_name: 'Lakeside Bitcoin Club', about: 'Monthly meetups by the lake.', picture: 'https://example.org/p.png', website: 'https://example.org' }));
const calendar = sign(31924, [['d', 'main'], ['title', 'Lakeside events'], ['a', `31923:${organizer}:oct`]], '');
const relayList = sign(10002, [['r', 'wss://home.test']]);

test('a native calendar is read by its author, and its events are served as records', async () => {
  const h = nativeHarness({ [OWN]: [relayList], 'wss://general.test': [profile], 'wss://home.test': [meetup, fest, calendar] });
  fileNative(h);
  const report = await h.indexer.tick();
  assert.deepEqual(report.polled, [nativeD(organizer)]);
  assert.deepEqual(report.failed, []);
  const entry = h.dir.get(nativeD(organizer))!;
  assert.equal(entry.name, 'Lakeside Bitcoin Club');
  assert.equal(entry.description, 'Monthly meetups by the lake.');
  assert.equal(entry.image, 'https://example.org/p.png');
  assert.equal(entry.pageUrl, 'https://example.org');
  assert.equal(entry.nativeCalendar, `31924:${organizer}:main`);
  assert.deepEqual(entry.ownerRelays, ['wss://home.test']);
  assert.equal(entry.pubkey, null, 'no calendar key is made for it');
  assert.equal(h.vault.pubkeyFor(entry.d), null);
  const rows = h.events.byCalendar(entry.d, NOW - 86400, NOW + 30 * 86400);
  assert.deepEqual(rows.map((r) => r.title), ['October meetup', 'Harvest festival']);
  assert.ok(h.db.record(rows[0]!.recordId)!.ics.includes('X-EVENTINDEX-NOSTR:naddr1'));
});

test('the index signs nothing for a native calendar but its directory entry, and follows its organizer', async () => {
  const h = nativeHarness({ [OWN]: [relayList], 'wss://home.test': [meetup, profile, calendar] });
  fileNative(h);
  await h.indexer.tick();
  assert.ok(h.sent.every((s) => s.event.pubkey === h.indexPubkey), 'only the index key signs');
  const entry = h.sent.find((s) => s.event.kind === 39999)!.event;
  assert.deepEqual(entry.tags.filter((t) => ['p', 'source', 'calendar', 'feed'].includes(t[0]!)), [
    ['p', organizer], ['source', 'nostr'], ['calendar', `31924:${organizer}:main`],
  ]);
  const follows = h.sent.find((s) => s.event.kind === 3)!.event;
  assert.deepEqual(follows.tags, [['p', organizer, 'wss://relay.eventindex.space']]);
});

test('a read no relay answers is a failed poll, and the events read before stay', async () => {
  const held: Record<string, VerifiedEvent[]> = { [OWN]: [relayList], 'wss://home.test': [meetup, profile] };
  const h = nativeHarness(held);
  fileNative(h);
  await h.indexer.tick();
  assert.equal(h.events.countByCalendar(nativeD(organizer)), 1);
  for (const key of Object.keys(held)) delete held[key];
  h.db.savePollState(nativeD(organizer), { ...h.db.pollState(nativeD(organizer)), nextPollAt: 0 });
  const report = await h.indexer.tick();
  assert.deepEqual(report.failed, [nativeD(organizer)]);
  assert.equal(h.events.countByCalendar(nativeD(organizer)), 1);
  assert.equal(h.db.pollState(nativeD(organizer)).failures, 1);
});

test('an event the organizer deletes leaves the index at the next read', async () => {
  const held: Record<string, VerifiedEvent[]> = { [OWN]: [relayList], 'wss://home.test': [meetup, fest, profile] };
  const h = nativeHarness(held);
  fileNative(h);
  await h.indexer.tick();
  assert.equal(h.events.countByCalendar(nativeD(organizer)), 2);
  held['wss://home.test']!.push(sign(5, [['a', `31922:${organizer}:fest`]], '', NOW - 10));
  h.db.savePollState(nativeD(organizer), { ...h.db.pollState(nativeD(organizer)), nextPollAt: 0 });
  await h.indexer.tick();
  assert.deepEqual(h.events.byCalendar(nativeD(organizer), NOW - 86400, NOW + 30 * 86400).map((r) => r.title), ['October meetup']);
});
