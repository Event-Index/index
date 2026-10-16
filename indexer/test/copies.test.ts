// Copies and originals: an aggregator's copy of an organizer's own event, and
// a mirrored feed's copy of an event its organizer also publishes on nostr.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCopies, sameTitle, type Candidate, ORGANIZER, FEED, AGGREGATOR } from '../src/rules/copies.ts';

const AT = 1792621800;
const row = (id: string, calendarD: string, rank: Candidate['rank'], extra: Partial<Candidate> = {}): Candidate => ({
  id, calendarD, rank, start: AT, title: 'Fort Bitcoin #62 Panther City BBQ — Proof of Smoke', g: null, ...extra,
});

test('an aggregator\'s copy names the organizer\'s own event as its original', () => {
  const copies = findCopies([
    row('orig', 'nostr:organizer', ORGANIZER),
    row('copy', 'nostr:aggregator', AGGREGATOR, { g: '9vff1rf1x' }),
    row('other', 'nostr:aggregator', AGGREGATOR, { title: 'Fort Bitcoin #61 Summer Ends', start: AT - 30 * 86400 }),
  ]);
  assert.deepEqual([...copies], [['copy', 'orig']]);
});

test('a feed\'s copy yields to the organizer\'s own event, and an aggregator\'s copy to either', () => {
  const copies = findCopies([
    row('native', 'nostr:org', ORGANIZER),
    row('mirror', 'meetup:group', FEED),
    row('agg', 'nostr:agg', AGGREGATOR),
  ]);
  assert.deepEqual(copies.get('mirror'), 'native');
  assert.deepEqual(copies.get('agg'), 'native', 'the organizer\'s own event is preferred');
  assert.equal(copies.get('native'), undefined);
  assert.deepEqual([...findCopies([row('mirror', 'meetup:group', FEED), row('agg', 'nostr:agg', AGGREGATOR)])], [['agg', 'mirror']]);
});

test('a small difference in start is tolerated; a different day, title or place is another event', () => {
  assert.equal(findCopies([row('o', 'nostr:o', ORGANIZER), row('c', 'nostr:a', AGGREGATOR, { start: AT + 1200 })]).get('c'), 'o');
  assert.equal(findCopies([row('o', 'nostr:o', ORGANIZER), row('c', 'nostr:a', AGGREGATOR, { start: AT + 86400 })]).get('c'), undefined);
  assert.equal(findCopies([row('o', 'nostr:o', ORGANIZER), row('c', 'nostr:a', AGGREGATOR, { title: 'Bitcoin & Coffee' })]).get('c'), undefined);
  assert.equal(findCopies([row('o', 'nostr:o', ORGANIZER, { g: '9vff1rf1x' }), row('c', 'nostr:a', AGGREGATOR, { g: 'dr5ru7' })]).get('c'), undefined, 'far apart');
  assert.equal(findCopies([row('o', 'nostr:o', ORGANIZER, { g: '9vff1rf1x' }), row('c', 'nostr:a', AGGREGATOR, { g: '9vff1rf2k' })]).get('c'), 'o', 'near each other');
});

test('events of one calendar, and two organizers\' own events, are never copies of each other', () => {
  assert.equal(findCopies([row('a', 'nostr:o', ORGANIZER), row('b', 'nostr:o', ORGANIZER)]).size, 0);
  assert.equal(findCopies([row('a', 'nostr:o', ORGANIZER), row('b', 'nostr:p', ORGANIZER)]).size, 0);
  assert.equal(findCopies([row('a', 'nostr:agg', AGGREGATOR), row('b', 'nostr:agg', AGGREGATOR)]).size, 0);
});

test('titles match whatever their case, accents, punctuation, or a cancelled prefix; a long one may hold the other', () => {
  assert.ok(sameTitle('Fort Bitcoin #50 Back to the House of B', 'fort bitcoin 50 – back to the house of b'));
  assert.ok(sameTitle('Café Crème Meetup', 'Cafe Creme Meetup'));
  assert.ok(sameTitle('Cancelled: Bitcoin Walk', 'Bitcoin Walk'));
  assert.ok(sameTitle('Fort Bitcoin Meetup #48.2 CEO Forum Bitcoin Lectures', 'Fort Bitcoin Meetup #48.2 CEO Forum Bitcoin Lectures @ TCU Neeley'));
  assert.ok(!sameTitle('Meetup', 'Meetup at the pub'), 'a short title is not enough to hold another');
  assert.ok(!sameTitle('Fort Bitcoin #48', 'Fort Bitcoin #49'));
});
