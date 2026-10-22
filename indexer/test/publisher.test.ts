import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, type VerifiedEvent } from 'nostr-tools/pure';
import { relayPublisher, memoryPauses, PAUSE_SECONDS, RETRY_WAIT, RETRY_TRIES, type RelayPool, type PublisherOptions } from '../src/service/publisher.ts';
import { loadSettings } from '../src/config.ts';

const sk = generateSecretKey();
const events = (n: number, kind = 31923) => Array.from({ length: n }, (_, i) => finalizeEvent({ kind, tags: [['d', String(i)]], content: '', created_at: 1792108800 + i }, sk));
const settings = loadSettings({
  EVENTINDEX_SEARCH_RELAYS: 'wss://search.example', EVENTINDEX_LIST_RELAYS: 'wss://lists.example',
  EVENTINDEX_PROFILE_RELAYS: 'wss://profiles.example', EVENTINDEX_GENERAL_RELAYS: 'wss://a.example,wss://b.example',
});

// A fake clock: sleeping moves it forward at once, and the waits are recorded.
function clock(start = 1792108800_000) {
  let now = start;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { waits.push(ms); now += ms; await new Promise((r) => setImmediate(r)); },
    advance: (ms: number) => { now += ms; },
    waits,
  };
}

// Answers per relay: a function of the event and how often the relay saw it.
function fakePool(answer: (relay: string, event: VerifiedEvent, seen: number) => string | null) {
  const got = new Map<string, VerifiedEvent[]>();
  const seen = new Map<string, number>();
  const pool: RelayPool = {
    publish: (relays, event) => relays.map(async (relay) => {
      const key = `${relay} ${event.id}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const refusal = answer(relay, event, n);
      if (refusal) throw new Error(refusal);
      got.set(relay, [...(got.get(relay) ?? []), event]);
      return '';
    }),
    querySync: async () => [],
    close: () => {},
  };
  return { pool, got };
}

function setup(answer: Parameters<typeof fakePool>[0], extra: Partial<PublisherOptions> = {}) {
  const { pool, got } = fakePool(answer);
  const c = clock();
  const lines: string[] = [];
  const pauses = extra.pauses ?? memoryPauses();
  const publisher = relayPublisher(settings, (l) => lines.push(l), { pool, now: c.now, sleep: c.sleep, pauses, ...extra });
  return { publisher, got, c, lines, pauses };
}

async function settled(publisher: ReturnType<typeof relayPublisher>): Promise<void> {
  for (let i = 0; i < 2000 && publisher.pending!() > 0; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(publisher.pending!(), 0);
}

test('each set sends its events to every relay in it', async () => {
  const { publisher, got, lines } = setup(() => null);
  await publisher.publish(events(3), 'general');
  await publisher.publish(events(2, 39999), 'lists');
  await settled(publisher);
  assert.equal(got.get('wss://a.example')!.length, 3);
  assert.equal(got.get('wss://b.example')!.length, 3);
  assert.equal(got.get('wss://lists.example')!.length, 2);
  assert.equal(got.get('wss://search.example'), undefined);
  assert.ok(lines.includes('general wss://a.example: 3 taken, 0 refused'));
});

test('a general relay gets a small burst, then one event every few seconds', async () => {
  const { pool, got } = fakePool(() => null);
  const c = clock();
  const publisher = relayPublisher(loadSettings({ EVENTINDEX_GENERAL_RELAYS: 'wss://a.example' }), () => {}, { pool, now: c.now, sleep: c.sleep });
  await publisher.publish(events(8), 'general');
  await settled(publisher);
  assert.equal(got.get('wss://a.example')!.length, 8);
  // Three at once, then the other five three seconds apart.
  const waits = c.waits.filter((w) => w > 0);
  assert.equal(waits.length, 5);
  assert.ok(waits.every((w) => Math.abs(w - 3000) < 1), waits.join(','));
});

test('a rate-limited relay is paused for a day and keeps its events; the others carry on', async () => {
  let limited = false;
  const { publisher, got, c, lines, pauses } = setup((relay) => {
    if (relay !== 'wss://a.example' || limited) return null;
    limited = true;
    return 'rate-limited: slow down';
  });
  await publisher.publish(events(3), 'general');
  await settled(publisher);
  assert.equal(got.get('wss://b.example')!.length, 3);
  assert.equal(got.get('wss://a.example'), undefined, 'nothing more after the reply');
  const state = pauses.get('wss://a.example')!;
  assert.equal(state.strikes, 1);
  assert.equal(state.until, Math.floor(c.now() / 1000) + PAUSE_SECONDS);
  assert.ok(lines.some((l) => l.startsWith('general wss://a.example: rate-limited: slow down; paused until 2026-')));
  // A day later, the relay is tried again, more slowly, with the events it missed.
  c.advance(PAUSE_SECONDS * 1000 + 1000);
  await publisher.publish([], 'general');
  for (let i = 0; i < 2000 && (got.get('wss://a.example')?.length ?? 0) < 3; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(got.get('wss://a.example')!.length, 3);
});

test('a relay that bans is paused; refused again after its pause, it is left off', async () => {
  const { publisher, c, lines, pauses } = setup((relay) => (relay === 'wss://a.example' ? 'banned: too many rate-limit violations, try again later' : null));
  await publisher.publish(events(2), 'general');
  await settled(publisher);
  assert.equal(pauses.get('wss://a.example')!.strikes, 1);
  c.advance(PAUSE_SECONDS * 1000 + 1000);
  await publisher.publish([], 'general');
  for (let i = 0; i < 2000 && pauses.get('wss://a.example')!.until !== null; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(pauses.get('wss://a.example'), { until: null, strikes: 2 });
  assert.ok(lines.some((l) => l.startsWith('general wss://a.example: left off after a second refusal: banned')));
  assert.equal(publisher.pending!(), 0, 'a relay left off holds no events');
});

test('a pause in the store is honored from the start', async () => {
  const pauses = memoryPauses();
  const c0 = clock();
  pauses.set('wss://a.example', { until: Math.floor(c0.now() / 1000) + 3600, strikes: 1 });
  const { publisher, got } = setup(() => null, { pauses });
  await publisher.publish(events(2), 'general');
  await settled(publisher);
  assert.equal(got.get('wss://a.example'), undefined);
  assert.equal(got.get('wss://b.example')!.length, 2);
});

test('other refusals are logged once per relay and message', async () => {
  const { publisher, lines } = setup((relay) => (relay === 'wss://b.example' ? 'blocked: kind not accepted' : null));
  await publisher.publish(events(3), 'general');
  await settled(publisher);
  assert.equal(lines.filter((l) => l.includes('blocked: kind not accepted')).length, 1);
  assert.ok(lines.includes('general wss://b.example: 0 taken, 3 refused'));
});

test('a send the relay never answers is tried again after the others, and after a wait that doubles', async () => {
  const [first, second, third] = events(3);
  const { publisher, got, c, lines } = setup((relay, event, seen) => (relay === 'wss://lists.example' && event.id === first!.id && seen <= 3 ? 'publish timed out' : null));
  await publisher.publish([first!, second!, third!], 'lists');
  await settled(publisher);
  assert.deepEqual(got.get('wss://lists.example')!.map((e) => e.id), [second!.id, third!.id, first!.id]);
  // The others' answers end the first wait; alone, it doubles.
  const waits = c.waits.filter((w) => w >= RETRY_WAIT.firstMs);
  assert.deepEqual(waits, [RETRY_WAIT.firstMs, RETRY_WAIT.firstMs, RETRY_WAIT.firstMs * 2]);
  assert.ok(lines.includes('lists wss://lists.example: 3 taken, 0 refused, 3 retried'), lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('publish timed out')).length, 1, 'logged once');
});

test('a failed or closed connection is tried again like a timeout', async () => {
  const { publisher, got } = setup((relay, _event, seen) => {
    if (relay !== 'wss://search.example' || seen > 1) return null;
    return seen === 1 ? 'connection failure: connection timed out' : null;
  });
  const closed = setup((relay, _event, seen) => (relay === 'wss://search.example' && seen === 1 ? 'relay connection closed' : null));
  await publisher.publish(events(2), 'search');
  await closed.publisher.publish(events(2), 'search');
  await settled(publisher);
  await settled(closed.publisher);
  assert.equal(got.get('wss://search.example')!.length, 2);
  assert.equal(closed.got.get('wss://search.example')!.length, 2);
});

test('a send the relay answers resets the wait', async () => {
  const [first, second] = events(2);
  const { publisher, c } = setup((relay, event, seen) => (relay === 'wss://lists.example' && seen <= 2 ? 'publish timed out' : null));
  await publisher.publish([first!], 'lists');
  await settled(publisher);
  await publisher.publish([second!], 'lists');
  await settled(publisher);
  assert.deepEqual(c.waits.filter((w) => w >= RETRY_WAIT.firstMs), [RETRY_WAIT.firstMs, RETRY_WAIT.firstMs * 2, RETRY_WAIT.firstMs, RETRY_WAIT.firstMs * 2]);
});

test('an event never answered is given up after its last try and counted refused', async () => {
  const { publisher, got, c, lines } = setup((relay) => (relay === 'wss://lists.example' ? 'publish timed out' : null));
  await publisher.publish(events(1), 'lists');
  await settled(publisher);
  assert.equal(got.get('wss://lists.example'), undefined);
  const waits = c.waits.filter((w) => w >= RETRY_WAIT.firstMs);
  assert.equal(waits.length, RETRY_TRIES - 1);
  assert.ok(waits.every((w) => w <= RETRY_WAIT.maxMs));
  assert.equal(Math.max(...waits), RETRY_WAIT.maxMs);
  assert.ok(lines.includes(`lists wss://lists.example: gave up on kind 31923 after ${RETRY_TRIES} tries: publish timed out`), lines.join('\n'));
  assert.ok(lines.includes(`lists wss://lists.example: 0 taken, 1 refused, ${RETRY_TRIES - 1} retried`), lines.join('\n'));
});

test('a refusal the relay answers is not sent again', async () => {
  const seen: number[] = [];
  const { publisher, c } = setup((relay, _event, n) => {
    if (relay !== 'wss://lists.example') return null;
    seen.push(n);
    return 'replaced: have newer event';
  });
  await publisher.publish(events(2), 'lists');
  await settled(publisher);
  assert.deepEqual(seen, [1, 1]);
  assert.equal(c.waits.filter((w) => w >= RETRY_WAIT.firstMs).length, 0);
});

test('an event waiting to be tried again still counts as pending for its relay', async () => {
  let pendingAtRetry = -1;
  const holder: { publisher?: ReturnType<typeof relayPublisher> } = {};
  const { publisher } = setup((relay, _event, seen) => {
    if (relay !== 'wss://lists.example') return null;
    if (seen === 2) pendingAtRetry = holder.publisher!.pendingFor!('wss://lists.example');
    return seen === 1 ? 'publish timed out' : null;
  });
  holder.publisher = publisher;
  await publisher.publish(events(1), 'lists');
  await settled(publisher);
  assert.equal(pendingAtRetry, 1);
});

test('a retry is dropped once a newer version of the same address waits to be sent', async () => {
  const older = finalizeEvent({ kind: 39999, tags: [['d', 'item']], content: '', created_at: 1792108800 }, sk);
  const newer = finalizeEvent({ kind: 39999, tags: [['d', 'item']], content: 'changed', created_at: 1792108900 }, sk);
  const tried: string[] = [];
  const { publisher, got } = setup((relay, event) => {
    if (relay !== 'wss://lists.example') return null;
    tried.push(event.id);
    return event.id === older.id ? 'publish timed out' : null;
  });
  await publisher.publish([older, newer], 'lists');
  await settled(publisher);
  assert.deepEqual(tried, [older.id, newer.id]);
  assert.deepEqual(got.get('wss://lists.example')!.map((e) => e.id), [newer.id]);
});

test('an empty set sends nothing and queues nothing', async () => {
  const { pool, got } = fakePool(() => null);
  const publisher = relayPublisher(loadSettings({ EVENTINDEX_SEARCH_RELAYS: 'none' }), () => {}, { pool });
  await publisher.publish(events(2), 'search');
  assert.equal(publisher.pending!(), 0);
  assert.equal(got.size, 0);
});

test('events for an organizer\'s own relays go to all of them and need one to take each', async () => {
  const { publisher, got } = setup((relay) => (relay === 'wss://down.example' ? 'connection failed' : null));
  const list = events(2);
  await publisher.publishTo!(list, ['wss://home.example', 'wss://down.example']);
  assert.deepEqual(got.get('wss://home.example')!.map((e) => e.id), list.map((e) => e.id));
  const none = setup(() => 'blocked: not here');
  await assert.rejects(none.publisher.publishTo!(events(1), ['wss://home.example', 'wss://down.example']), /no relay took/);
});

test('RSVPs are read from the index\'s relay and the relays named', async () => {
  const asked: string[][] = [];
  const pool: RelayPool = { publish: () => [], querySync: async (relays) => { asked.push(relays); return []; }, close: () => {} };
  const publisher = relayPublisher(settings, () => {}, { pool });
  await publisher.rsvps('ab'.repeat(32), ['wss://home.example']);
  assert.deepEqual(asked, [[settings.relayUrl, 'wss://home.example']]);
});

test('what one outside relay holds is read from it alone, a search relay with its include:spam extension', async () => {
  const asked: Array<{ relays: string[]; filter: unknown; maxWait?: number }> = [];
  const pool: RelayPool = { publish: () => [], querySync: async (relays, filter, params) => { asked.push({ relays, filter, maxWait: params?.maxWait }); return []; }, close: () => {} };
  const publisher = relayPublisher(settings, () => {}, { pool });
  await publisher.fetchFrom!('wss://lists.example', { kinds: [39999], '#d': ['x'] });
  await publisher.fetchFrom!('wss://search.example', { kinds: [39999], '#d': ['x'] });
  assert.deepEqual(asked.map((a) => a.relays), [['wss://lists.example'], ['wss://search.example']]);
  assert.deepEqual(asked[0]!.filter, { kinds: [39999], '#d': ['x'] });
  assert.deepEqual(asked[1]!.filter, { kinds: [39999], '#d': ['x'], search: 'include:spam' });
  assert.ok(asked.every((a) => (a.maxWait ?? 0) >= 10_000), 'a slow relay is waited for');
});
