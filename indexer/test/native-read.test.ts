// Reading a native calendar's events by author: its relay list, its newest
// version of each event, and its own deletions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { matchFilter } from 'nostr-tools/filter';
import { readAuthor, outsideRelay, type RelayReader } from '../src/native/read.ts';
import { NOW } from './helpers.ts';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const other = generateSecretKey();
const sign = (kind: number, tags: string[][], content = '', at = NOW - 3600, key = sk): VerifiedEvent =>
  finalizeEvent({ kind, tags, content, created_at: at }, key);

// Relays as maps of their events; a relay missing from the map does not answer.
function relays(held: Record<string, VerifiedEvent[]>): RelayReader & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async query(urls: string[], filter: Filter) {
      asked.push(urls);
      const answered = urls.filter((u) => held[u]);
      return { answered, found: answered.flatMap((relay) => held[relay]!.filter((e) => matchFilter(filter, e)).map((event) => ({ event, relay }))) };
    },
  };
}

const USUAL = ['wss://own.test', 'wss://general.test'];
const allowAll = async () => true;

test('events are read from the usual relays and the author\'s write relays', async () => {
  const list = sign(10002, [['r', 'wss://home.test'], ['r', 'wss://inbox.test', 'read'], ['r', 'wss://out.test', 'write']]);
  const one = sign(31923, [['d', 'a'], ['title', 'A'], ['start', String(NOW + 86400)]]);
  const two = sign(31922, [['d', 'b'], ['title', 'B'], ['start', '2026-11-01']]);
  const reader = relays({ 'wss://own.test': [list], 'wss://general.test': [], 'wss://home.test': [one], 'wss://out.test': [two], 'wss://inbox.test': [] });
  const read = await readAuthor(reader, pubkey, USUAL, { relayAllowed: allowAll });
  assert.equal(read.ok, true);
  assert.deepEqual(read.writeRelays, ['wss://home.test', 'wss://out.test']);
  assert.deepEqual(read.events.map((f) => f.event.id).sort(), [one.id, two.id].sort());
  assert.ok(!reader.asked.flat().includes('wss://inbox.test'), 'a read-only relay is not where the author publishes');
});

test('the newest version of each event wins, and only the author\'s signed events count', async () => {
  const old = sign(31923, [['d', 'a'], ['title', 'Old'], ['start', String(NOW + 86400)]], '', NOW - 7200);
  const fresh = sign(31923, [['d', 'a'], ['title', 'New'], ['start', String(NOW + 86400)]], '', NOW - 60);
  const forged = { ...sign(31923, [['d', 'z'], ['title', 'Forged'], ['start', String(NOW + 86400)]]), sig: '0'.repeat(128) } as VerifiedEvent;
  const stranger = sign(31923, [['d', 'q'], ['title', 'Someone else'], ['start', String(NOW + 86400)]], '', NOW, other);
  const reader = relays({ 'wss://own.test': [old, forged, { ...stranger, pubkey } as VerifiedEvent], 'wss://general.test': [fresh] });
  const read = await readAuthor(reader, pubkey, USUAL, { relayAllowed: allowAll });
  assert.deepEqual(read.events.map((f) => f.event.tags.find((t) => t[0] === 'title')![1]), ['New']);
  assert.equal(read.events[0]!.relay, 'wss://general.test');
});

test('the author\'s own deletions are honored, by id and by address', async () => {
  const byId = sign(31923, [['d', 'a'], ['title', 'A'], ['start', String(NOW + 86400)]]);
  const byAddress = sign(31923, [['d', 'b'], ['title', 'B'], ['start', String(NOW + 86400)]], '', NOW - 7200);
  const republished = sign(31923, [['d', 'c'], ['title', 'C again'], ['start', String(NOW + 86400)]], '', NOW - 10);
  const kept = sign(31923, [['d', 'd'], ['title', 'D'], ['start', String(NOW + 86400)]]);
  const deletion = sign(5, [['e', byId.id], ['a', `31923:${pubkey}:b`], ['a', `31923:${pubkey}:c`]], '', NOW - 100);
  const foreign = sign(5, [['e', kept.id]], '', NOW, other);
  const reader = relays({ 'wss://own.test': [byId, byAddress, republished, kept, deletion, foreign], 'wss://general.test': [] });
  const read = await readAuthor(reader, pubkey, USUAL, { relayAllowed: allowAll });
  assert.deepEqual(read.events.map((f) => f.event.tags[0]![1]).sort(), ['c', 'd']);
});

test('the profile and calendars are read with the events', async () => {
  const profile = sign(0, [], JSON.stringify({ name: 'lakeside', display_name: 'Lakeside Bitcoin Club', about: 'Monthly meetups.', picture: 'https://example.org/p.png', website: 'https://example.org' }));
  const calendar = sign(31924, [['d', 'main'], ['title', 'Lakeside events']], 'All our events.');
  const reader = relays({ 'wss://own.test': [profile, calendar], 'wss://general.test': [] });
  const read = await readAuthor(reader, pubkey, USUAL, { relayAllowed: allowAll });
  assert.deepEqual(read.profile, { name: 'Lakeside Bitcoin Club', about: 'Monthly meetups.', picture: 'https://example.org/p.png', website: 'https://example.org' });
  assert.deepEqual(read.calendars.map((c) => c.id), [calendar.id]);
});

test('a read with no relay answering is not ok', async () => {
  const read = await readAuthor(relays({}), pubkey, USUAL, { relayAllowed: allowAll });
  assert.equal(read.ok, false);
  assert.deepEqual(read.events, []);
});

test('write relays the index will not connect to are left out', async () => {
  const list = sign(10002, [['r', 'wss://home.test'], ['r', 'ws://plain.test'], ['r', 'wss://blocked.test']]);
  const reader = relays({ 'wss://own.test': [list], 'wss://general.test': [] });
  const read = await readAuthor(reader, pubkey, USUAL, { relayAllowed: async (url) => url.startsWith('wss://') && url !== 'wss://blocked.test' });
  assert.deepEqual(read.writeRelays, ['wss://home.test']);
});

test('an outside relay is a wss address on a public host', async () => {
  const resolve = async (host: string) => (host === 'relay.example.org' ? ['93.184.216.34'] : host === 'sneaky.example.org' ? ['10.0.0.5'] : []);
  assert.equal(await outsideRelay('wss://relay.example.org', resolve), true);
  assert.equal(await outsideRelay('wss://relay.example.org/path', resolve), true);
  assert.equal(await outsideRelay('ws://relay.example.org', resolve), false);
  assert.equal(await outsideRelay('wss://sneaky.example.org', resolve), false);
  assert.equal(await outsideRelay('wss://127.0.0.1', resolve), false);
  assert.equal(await outsideRelay('wss://localhost', resolve), false);
  assert.equal(await outsideRelay('wss://nowhere.example.org', resolve), false);
  assert.equal(await outsideRelay('wss://user:pw@relay.example.org', resolve), false);
  assert.equal(await outsideRelay('not a url', resolve), false);
});
