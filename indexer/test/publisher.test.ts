import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, type VerifiedEvent } from 'nostr-tools/pure';
import { relayPublisher, type RelayPool } from '../src/service/publisher.ts';
import { loadSettings } from '../src/config.ts';

const FAST = { search: 1000, lists: 1000, profiles: 1000, general: 1000 };
const sk = generateSecretKey();
const events = (n: number, kind = 31923) => Array.from({ length: n }, (_, i) => finalizeEvent({ kind, tags: [['d', String(i)]], content: '', created_at: 1792108800 + i }, sk));
const settings = loadSettings({
  EVENTINDEX_SEARCH_RELAYS: 'wss://search.example', EVENTINDEX_LIST_RELAYS: 'wss://lists.example',
  EVENTINDEX_PROFILE_RELAYS: 'wss://profiles.example', EVENTINDEX_GENERAL_RELAYS: 'wss://a.example,wss://b.example',
});

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

async function settled(publisher: ReturnType<typeof relayPublisher>): Promise<void> {
  for (let i = 0; i < 500 && publisher.pending!() > 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(publisher.pending!(), 0);
}

test('each set sends its events to every relay in it', async () => {
  const { pool, got } = fakePool(() => null);
  const lines: string[] = [];
  const publisher = relayPublisher(settings, (l) => lines.push(l), FAST, pool);
  await publisher.publish(events(3), 'general');
  await publisher.publish(events(2, 39999), 'lists');
  await settled(publisher);
  assert.equal(got.get('wss://a.example')!.length, 3);
  assert.equal(got.get('wss://b.example')!.length, 3);
  assert.equal(got.get('wss://lists.example')!.length, 2);
  assert.equal(got.get('wss://search.example'), undefined);
  assert.ok(lines.includes('general wss://a.example: 3 taken, 0 refused'));
});

test('a rate-limited event is sent again, and other refusals are logged once per relay and message', async () => {
  const { pool, got } = fakePool((relay, event, seen) => {
    if (relay === 'wss://a.example' && seen === 1) return 'rate-limited: slow down';
    if (relay === 'wss://b.example') return 'blocked: kind not accepted';
    return null;
  });
  const lines: string[] = [];
  const publisher = relayPublisher(settings, (l) => lines.push(l), FAST, pool);
  await publisher.publish(events(3), 'general');
  await settled(publisher);
  assert.equal(got.get('wss://a.example')!.length, 3, 'each taken on the second try');
  assert.equal(lines.filter((l) => l.includes('blocked: kind not accepted')).length, 1);
  assert.ok(lines.includes('general wss://b.example: 0 taken, 3 refused'));
  assert.ok(!lines.some((l) => l.includes('rate-limited')), 'a retried rate limit is not a refusal');
});

test('a relay that keeps rate-limiting is given up on after a few tries', async () => {
  const { pool } = fakePool((relay) => (relay === 'wss://a.example' ? 'rate-limited: no' : null));
  const lines: string[] = [];
  const publisher = relayPublisher(settings, (l) => lines.push(l), FAST, pool);
  await publisher.publish(events(1), 'general');
  await settled(publisher);
  assert.ok(lines.some((l) => l.startsWith('general wss://a.example refused kind 31923: rate-limited')));
});

test('an empty set sends nothing and queues nothing', async () => {
  const { pool, got } = fakePool(() => null);
  const publisher = relayPublisher(loadSettings({ EVENTINDEX_SEARCH_RELAYS: 'none' }), () => {}, FAST, pool);
  await publisher.publish(events(2), 'search');
  assert.equal(publisher.pending!(), 0);
  assert.equal(got.size, 0);
});
