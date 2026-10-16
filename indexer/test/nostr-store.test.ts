// The NIP-52 events the index has read, as their publishers signed them:
// the newest version of each address, their own deletions honored, and the
// publishers whose events changed since their records were last built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb } from '../src/store/index-db.ts';
import { nostrStore } from '../src/store/nostr-events.ts';

const NOW = 1_792_000_000;
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const sign = (kind: number, tags: string[][], at: number, key = sk): VerifiedEvent => finalizeEvent({ kind, tags, content: '', created_at: at }, key);
const event = (d: string, at: number, title = d) => sign(31923, [['d', d], ['title', title], ['start', String(NOW + 86400)]], at);

test('the newest version of each address is kept, signed as it was received', () => {
  const store = nostrStore(openIndexDb(':memory:'));
  const first = event('a', NOW - 100, 'First');
  assert.equal(store.put({ event: first, relay: 'wss://r1.example' }, NOW), 'new');
  assert.equal(store.put({ event: first, relay: 'wss://r2.example' }, NOW), 'same');
  assert.equal(store.put({ event: event('a', NOW - 200, 'Older'), relay: null }, NOW), 'older');
  const second = event('a', NOW - 50, 'Second');
  assert.equal(store.put({ event: second, relay: null }, NOW), 'newer');
  const kept = store.eventsOf(pubkey);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0]!.event, JSON.parse(JSON.stringify(second)));
  assert.equal(kept[0]!.relay, 'wss://r1.example', 'the relay it was first read from stays its hint');
});

test('a publisher whose events change waits for its records to be built again', () => {
  const store = nostrStore(openIndexDb(':memory:'));
  store.put({ event: event('a', NOW), relay: null }, NOW);
  store.put({ event: event('b', NOW), relay: null }, NOW);
  assert.deepEqual(store.dirty(10), [pubkey]);
  store.built(pubkey);
  assert.deepEqual(store.dirty(10), []);
  store.put({ event: event('a', NOW), relay: null }, NOW + 5);
  assert.deepEqual(store.dirty(10), [], 'the same event changes nothing');
});

test('a publisher\'s own deletion removes an event by id or by address, and holds back an older copy read later', () => {
  const store = nostrStore(openIndexDb(':memory:'));
  const a = event('a', NOW - 100);
  const b = event('b', NOW - 100);
  store.put({ event: a, relay: null }, NOW);
  store.put({ event: b, relay: null }, NOW);
  store.built(pubkey);
  assert.equal(store.applyDeletion(sign(5, [['e', a.id]], NOW - 10), NOW), 1);
  assert.equal(store.applyDeletion(sign(5, [['a', `31923:${pubkey}:b`], ['k', '31923']], NOW - 10), NOW), 1);
  assert.deepEqual(store.eventsOf(pubkey), []);
  assert.deepEqual(store.dirty(10), [pubkey]);
  assert.equal(store.put({ event: a, relay: 'wss://another.example' }, NOW), 'deleted', 'an event deleted by id stays deleted when read again');
  const later = event('z', NOW - 30);
  store.applyDeletion(sign(5, [['e', later.id]], NOW - 10), NOW);
  assert.equal(store.put({ event: later, relay: null }, NOW), 'deleted', 'a deletion by id read before its event holds');
  assert.equal(store.put({ event: b, relay: null }, NOW), 'deleted', 'a copy no newer than the deletion stays deleted');
  assert.equal(store.applyDeletion(sign(5, [['a', `31923:${pubkey}:c`]], NOW - 10), NOW), 0);
  assert.equal(store.put({ event: event('c', NOW - 20), relay: null }, NOW), 'deleted', 'a deletion read before its event holds');
  assert.equal(store.put({ event: event('c', NOW - 5), relay: null }, NOW), 'new', 'a version after the deletion stands');
  const stranger = generateSecretKey();
  assert.equal(store.applyDeletion(sign(5, [['a', `31923:${pubkey}:c`]], NOW, stranger), NOW), 0, 'only the author can delete');
  const kept = event('k', NOW - 30);
  store.applyDeletion(sign(5, [['e', kept.id]], NOW - 10, stranger), NOW);
  assert.equal(store.put({ event: kept, relay: null }, NOW), 'new', 'nor hide an event by naming its id');
});

test('cursors and profiles are kept per relay and per publisher', () => {
  const store = nostrStore(openIndexDb(':memory:'));
  assert.equal(store.cursor('wss://r.example', 'events'), null);
  store.setCursor('wss://r.example', 'events', { phase: 'sync', until: null, newest: NOW, syncedAt: NOW, backfilledAt: NOW });
  assert.deepEqual(store.cursor('wss://r.example', 'events'), { phase: 'sync', until: null, newest: NOW, syncedAt: NOW, backfilledAt: NOW });
  store.setProfile(pubkey, { name: 'Lakeside', about: null, picture: null, website: null, createdAt: NOW }, NOW);
  assert.deepEqual(store.profile(pubkey), { name: 'Lakeside', about: null, picture: null, website: null, createdAt: NOW, checkedAt: NOW });
  assert.deepEqual(store.publishers(), [], 'a profile alone is no publisher');
  store.put({ event: event('a', NOW), relay: null }, NOW);
  assert.deepEqual(store.publishers(), [pubkey]);
  store.forget(pubkey);
  assert.deepEqual(store.eventsOf(pubkey), []);
});
