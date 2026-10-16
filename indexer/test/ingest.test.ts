// Reading every public NIP-52 event by kind: each relay's history page by
// page, then what is new, with the basic hygiene of a commons and nothing the
// index signs itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { openIndexDb } from '../src/store/index-db.ts';
import { nostrStore } from '../src/store/nostr-events.ts';
import { ingest, acceptable, PAGE, SYNC_EVERY, RESCAN_EVERY } from '../src/native/ingest.ts';
import type { RelayReader } from '../src/native/read.ts';

const NOW = 1_792_000_000;
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const sign = (kind: number, tags: string[][], at: number, key = sk): VerifiedEvent => finalizeEvent({ kind, tags, content: '', created_at: at }, key);
const event = (d: string, at: number, extra: string[][] = []) => sign(31923, [['d', d], ['title', `Event ${d}`], ['start', String(NOW + 86400)], ...extra], at);

// A relay that answers newest first, at most `cap` events, as relays do; a
// search relay answers only filters carrying its search extension.
function relay(held: VerifiedEvent[], options: { cap?: number; search?: boolean; down?: boolean } = {}) {
  const asked: Filter[] = [];
  const reader: RelayReader = {
    async query(urls, filter) {
      asked.push(filter);
      if (options.down) return { answered: [], found: [] };
      if (options.search && filter.search !== 'include:spam') return { answered: urls, found: [] };
      const { search: _, ...plain } = filter;
      const found = held.filter((e) => matchFilter({ ...plain, limit: undefined } as Filter, e))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, Math.min(filter.limit ?? 500, options.cap ?? 500));
      return { answered: urls, found: found.map((e) => ({ event: e, relay: urls[0]! })) };
    },
  };
  return { reader, asked };
}

const deps = (reader: RelayReader, store = nostrStore(openIndexDb(':memory:')), now = NOW) =>
  ({ reader, store, now, skip: () => false, log: () => {} });

test('a relay\'s history is read page by page, back to its first event, then kept up with', async () => {
  const held = Array.from({ length: 1200 }, (_, i) => event(`e${i}`, NOW - 5000 + i));
  const r = relay(held);
  const d = deps(r.reader);
  const first = await ingest([{ url: 'wss://r.example', search: false }], d);
  assert.equal(d.store.count(), 1200);
  assert.ok(first.kept === 1200);
  const cursor = d.store.cursor('wss://r.example', 'events')!;
  assert.equal(cursor.phase, 'sync');
  assert.equal(cursor.newest, NOW - 5000 + 1199);
  assert.ok(r.asked.length >= 3 && r.asked.every((f) => f.limit === PAGE));

  held.push(event('late', NOW + 10));
  r.asked.length = 0;
  const soon = await ingest([{ url: 'wss://r.example', search: false }], { ...d, now: NOW + 60 });
  assert.equal(soon.read, 0, 'nothing is asked before the next sync is due');
  await ingest([{ url: 'wss://r.example', search: false }], { ...d, now: NOW + SYNC_EVERY + 60 });
  assert.equal(d.store.count(), 1201);
  assert.ok(r.asked.some((f) => f.since === NOW - 5000 + 1199 - 3600), 'a sync asks from a little before the newest event seen');
});

test('a page that holds only one second moves on past it, so paging always ends', async () => {
  const held = Array.from({ length: 30 }, (_, i) => event(`same${i}`, NOW - 100));
  const d = deps(relay(held, { cap: 10 }).reader);
  await ingest([{ url: 'wss://r.example', search: false }], d);
  assert.equal(d.store.cursor('wss://r.example', 'events')!.phase, 'sync');
  assert.ok(d.store.count() >= 10);
});

test('a search relay is asked with its include:spam extension; a relay that does not answer is tried again', async () => {
  const search = relay([event('s', NOW - 10)], { search: true });
  const d = deps(search.reader);
  await ingest([{ url: 'wss://search.example', search: true }], d);
  assert.equal(d.store.count(), 1);
  assert.ok(search.asked.every((f) => f.search === 'include:spam'));
  const down = deps(relay([], { down: true }).reader);
  await ingest([{ url: 'wss://down.example', search: false }], down);
  assert.equal(down.store.cursor('wss://down.example', 'events')?.phase ?? 'backfill', 'backfill');
});

test('history is read again each week, to catch what a sync missed', async () => {
  const held = [event('a', NOW - 10)];
  const r = relay(held);
  const d = deps(r.reader);
  await ingest([{ url: 'wss://r.example', search: false }], d);
  held.push(event('backdated', NOW - 100000));
  await ingest([{ url: 'wss://r.example', search: false }], { ...d, now: NOW + SYNC_EVERY + 1 });
  assert.equal(d.store.count(), 1, 'a back-dated event is missed by a sync');
  await ingest([{ url: 'wss://r.example', search: false }], { ...d, now: NOW + RESCAN_EVERY + 1 });
  assert.equal(d.store.count(), 2);
});

test('hygiene: a bad signature, no d, no title, no start or an absurd date is left out', () => {
  assert.equal(acceptable(event('ok', NOW), NOW), null);
  assert.equal(acceptable({ ...event('x', NOW), sig: '00'.repeat(64) } as VerifiedEvent, NOW), 'signature');
  assert.equal(acceptable(sign(31923, [['title', 'T'], ['start', String(NOW)]], NOW), NOW), 'no-d');
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['start', String(NOW)]], NOW), NOW), 'no-title');
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['name', 'Old style'], ['start', String(NOW)]], NOW), NOW), null);
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['title', 'T']], NOW), NOW), 'no-start');
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['title', 'T'], ['start', 'soon']], NOW), NOW), 'bad-start');
  assert.equal(acceptable(sign(31922, [['d', 'x'], ['title', 'T'], ['start', '2026-02-30']], NOW), NOW), 'bad-start');
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['title', 'T'], ['start', '100']], NOW), NOW), 'absurd-date');
  assert.equal(acceptable(sign(31923, [['d', 'x'], ['title', 'T'], ['start', String(NOW + 20 * 365 * 86400)]], NOW), NOW), 'absurd-date');
  assert.equal(acceptable(sign(1, [['d', 'x'], ['title', 'T'], ['start', String(NOW)]], NOW), NOW), 'kind');
});

test('events the caller leaves out (the index\'s own) are not kept, and authors\' deletions are applied', async () => {
  const mine = generateSecretKey();
  const a = event('a', NOW - 50);
  const held = [a, event('b', NOW - 50), sign(31923, [['d', 'ours'], ['title', 'Ours'], ['start', String(NOW + 60)]], NOW - 50, mine),
    sign(5, [['e', a.id], ['k', '31923']], NOW - 10)];
  const d = { ...deps(relay(held).reader), skip: (e: { pubkey: string }) => e.pubkey === getPublicKey(mine) };
  const report = await ingest([{ url: 'wss://r.example', search: false }], d);
  assert.deepEqual(d.store.eventsOf(pubkey).map((s) => s.event.tags[0]![1]), ['b']);
  assert.equal(d.store.eventsOf(getPublicKey(mine)).length, 0);
  assert.equal(report.dropped['ours'], 1);
  assert.equal(report.deletions, 1);
});
