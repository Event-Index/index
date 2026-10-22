import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarPolicy } from '../src/adapters/index.ts';

const OWNER = 'ab'.repeat(32);
const SUMMARY = { fullDescription: false, images: false };

test('a calendar is served as summary and link until its organizer verifies with Event Index', () => {
  for (const source of ['luma', 'meetup', 'mobilizon', 'gancio', 'google', 'ics'] as const) {
    assert.deepEqual(calendarPolicy({ source, owner: null }), SUMMARY, source);
  }
});

test('once verified, a calendar gets its full description, and images where its source allows them', () => {
  assert.deepEqual(calendarPolicy({ source: 'luma', owner: OWNER }), { fullDescription: true, images: false });
  assert.deepEqual(calendarPolicy({ source: 'meetup', owner: OWNER }), { fullDescription: true, images: false });
  for (const source of ['mobilizon', 'gancio', 'google', 'ics'] as const) {
    assert.deepEqual(calendarPolicy({ source, owner: OWNER }), { fullDescription: true, images: true }, source);
  }
});

test('the loosening is undone when the calendar is kept reserved, or loses its verified organizer', () => {
  assert.deepEqual(calendarPolicy({ source: 'google', owner: OWNER }, true), SUMMARY);
  assert.deepEqual(calendarPolicy({ source: 'google', owner: null }, false), SUMMARY);
});

test('an organizer\'s own nostr events are served as they published them', () => {
  assert.deepEqual(calendarPolicy({ source: 'nostr', owner: OWNER }), { fullDescription: true, images: true });
  assert.deepEqual(calendarPolicy({ source: 'nostr', owner: null }), { fullDescription: true, images: true });
});
