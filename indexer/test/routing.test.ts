import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setsFor, type RouteContext } from '../src/service/routing.ts';

const INDEX = 'a'.repeat(64);
const CAL = 'b'.repeat(64);
const NOW = 1792108800;
const on: RouteContext = { indexPubkey: INDEX, now: NOW, outside: true };
const off: RouteContext = { ...on, outside: false };
const event = (pubkey: string, kind: number, tags: string[][] = []) => ({ pubkey, kind, tags });
const timed = (start: number) => event(CAL, 31923, [['d', 'x'], ['start', String(start)]]);
const dated = (date: string) => event(CAL, 31922, [['d', 'y'], ['start', date]]);

test('the directory goes to the search and list relays', () => {
  for (const kind of [39998, 39999]) assert.deepEqual(setsFor(event(INDEX, kind), on), ['search', 'lists']);
});

test('profiles and relay lists go to the search, profile and general relays', () => {
  for (const pubkey of [INDEX, CAL]) for (const kind of [0, 10002]) assert.deepEqual(setsFor(event(pubkey, kind), on), ['search', 'profiles', 'general']);
  assert.deepEqual(setsFor(event(INDEX, 3), on), ['search', 'profiles', 'general'], 'the index key\'s follow list');
});

test('calendars go to the search and general relays', () => {
  assert.deepEqual(setsFor(event(CAL, 31924), on), ['search', 'general']);
});

test('events in the window go to the search relays, and to the general relays only while upcoming', () => {
  assert.deepEqual(setsFor(timed(NOW + 3600), on), ['search', 'general']);
  assert.deepEqual(setsFor(timed(NOW - 3600), on), ['search']);
  assert.deepEqual(setsFor(dated('2026-10-16'), on), ['search', 'general'], 'an all-day event is upcoming through its day');
  assert.deepEqual(setsFor(dated('2026-10-14'), on), ['search']);
  assert.deepEqual(setsFor(timed(NOW - 31 * 86400), on), [], 'past the window: nowhere');
  assert.deepEqual(setsFor(timed(NOW - 29 * 86400), on), ['search']);
});

test('deletions follow the events to the search and general relays, but are never backfilled', () => {
  assert.deepEqual(setsFor(event(CAL, 5), on), ['search', 'general']);
  assert.deepEqual(setsFor(event(CAL, 5), { ...on, backfill: true }), []);
  assert.deepEqual(setsFor(timed(NOW + 3600), { ...on, backfill: true }), ['search', 'general']);
});

test('with outside publishing off, only the index key\'s profile and relay list leave, to the profile and general relays', () => {
  assert.deepEqual(setsFor(event(INDEX, 0), off), ['profiles', 'general']);
  assert.deepEqual(setsFor(event(INDEX, 10002), off), ['profiles', 'general']);
  for (const e of [event(INDEX, 3), event(CAL, 0), event(CAL, 10002), event(INDEX, 39999), event(CAL, 31924), timed(NOW + 3600), event(CAL, 5)]) {
    assert.deepEqual(setsFor(e, off), [], `kind ${e.kind}`);
  }
});

test('anything else goes nowhere outside', () => {
  for (const kind of [1, 7, 31925, 1111]) assert.deepEqual(setsFor(event(CAL, kind), on), []);
});
