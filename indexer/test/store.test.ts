import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIndexDb } from '../src/store/index-db.ts';
import { emptyPresence, type PresenceState } from '../src/rules/presence.ts';

const PK = 'c1'.repeat(32);

test('a projection is published when it is new or its hash changed', () => {
  const db = openIndexDb(':memory:');
  assert.equal(db.shouldPublish(PK, 31923, 'd1', 'h1'), true);
  db.markPublished({ pubkey: PK, kind: 31923, d: 'd1', hash: 'h1', eventId: 'e1', createdAt: 100, start: 5000 });
  assert.equal(db.shouldPublish(PK, 31923, 'd1', 'h1'), false);
  assert.equal(db.shouldPublish(PK, 31923, 'd1', 'h2'), true);
  assert.equal(db.shouldPublish(PK, 31922, 'd1', 'h1'), true, 'another kind is another address');
});

test('every published version id is kept for deletions', () => {
  const db = openIndexDb(':memory:');
  db.markPublished({ pubkey: PK, kind: 31923, d: 'd1', hash: 'h1', eventId: 'e1', createdAt: 100, start: 5000 });
  db.markPublished({ pubkey: PK, kind: 31923, d: 'd1', hash: 'h2', eventId: 'e2', createdAt: 101, start: 5000 });
  assert.deepEqual(db.versions(PK, 31923, 'd1'), ['e1', 'e2']);
  assert.equal(db.lastCreatedAt(PK, 31923, 'd1'), 101);
  assert.equal(db.lastCreatedAt(PK, 31923, 'nope'), null);
});

test('a withdrawn projection is marked, not forgotten', () => {
  const db = openIndexDb(':memory:');
  db.markPublished({ pubkey: PK, kind: 31923, d: 'd1', hash: 'h1', eventId: 'e1', createdAt: 100, start: 5000 });
  db.markWithdrawn(PK, 31923, 'd1', 'deleted');
  assert.equal(db.projection(PK, 31923, 'd1')!.status, 'deleted');
  assert.deepEqual(db.versions(PK, 31923, 'd1'), ['e1']);
});

test('presence state round-trips per calendar', () => {
  const db = openIndexDb(':memory:');
  const state: PresenceState = {
    events: { '31923:aa': { uid: 'u', recurring: false, start: 5000, missed: 1, firstMissedAt: 4000 } },
    quarantine: { reason: 'empty', since: 4500 },
  };
  db.savePresence('luma:cal-x', state);
  assert.deepEqual(db.loadPresence('luma:cal-x'), state);
  assert.deepEqual(db.loadPresence('luma:cal-y'), emptyPresence());
});

test('a local name is assigned once and never given to another calendar', () => {
  const db = openIndexDb(':memory:');
  assert.equal(db.localNameFor('luma:cal-AbCdEf'), 'luma-cal-abcdef');
  assert.equal(db.localNameFor('luma:cal-abcdef'), 'luma-cal-abcdef-2');
  assert.equal(db.localNameFor('luma:cal-AbCdEf'), 'luma-cal-abcdef');
  assert.equal(db.calendarForLocalName('luma-cal-abcdef-2'), 'luma:cal-abcdef');
});

test('a record keeps its change time until its text changes', () => {
  const db = openIndexDb(':memory:');
  assert.equal(db.putRecord({ calendarD: 'c', uid: 'u', id: 'i', ics: 'A', now: 100 }), 100);
  assert.equal(db.putRecord({ calendarD: 'c', uid: 'u', id: 'i', ics: 'A', now: 200 }), 100);
  assert.equal(db.putRecord({ calendarD: 'c', uid: 'u', id: 'i', ics: 'B', now: 300 }), 300);
  assert.equal(db.record('i')!.ics, 'B');
});
