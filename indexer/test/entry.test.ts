import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { directoryEntry, eventCalendarsHeader, eventsHeader } from '../src/directory/entry.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor } from './helpers.ts';

const INDEX = 'e1'.repeat(32);
const CAL = 'c1'.repeat(32);

function entryFor(fixture: string, extra: { pubkey?: string | null; removed?: string } = {}) {
  const id = identify(feedUrlFor(fixture));
  const feed = normalizeFeed(readFixture(fixture), id);
  return directoryEntry({ identity: id, calendar: feed.calendar, indexPubkey: INDEX, pubkey: extra.pubkey === undefined ? CAL : extra.pubkey, removed: extra.removed });
}

test('a calendar entry names its key, feed, page and source', () => {
  const entry = entryFor('meetup-pythonsd.ics');
  assert.equal(entry.kind, 39999);
  assert.deepEqual(entry.tags, [
    ['d', 'meetup:pythonsd'],
    ['z', `39998:${INDEX}:event-calendars`],
    ['name', 'San Diego Python Users Group'],
    ['role', 'calendar'],
    ['p', CAL],
    ['feed', 'https://www.meetup.com/pythonsd/events/ical/'],
    ['url', 'https://www.meetup.com/pythonsd/'],
    ['source', 'meetup'],
  ]);
  assert.equal(entry.content, '');
});

test('an aggregator entry has no key', () => {
  const entry = entryFor('luma-city-nyc.ics', { pubkey: null });
  assert.deepEqual(entry.tags.find((t) => t[0] === 'role'), ['role', 'aggregator']);
  assert.equal(entry.tags.find((t) => t[0] === 'p'), undefined);
});

test('an entry carries the calendar description and, where the source allows images, its image', () => {
  const rich = entryFor('synthetic/rich.ics');
  assert.deepEqual(rich.tags.find((t) => t[0] === 'description'), ['description', 'A calendar that uses RFC 7986 and RFC 9073 properties.']);
  assert.deepEqual(rich.tags.find((t) => t[0] === 'image'), ['image', 'https://example.org/logo.png']);
});

test('a retired entry is republished with removed and its reason', () => {
  const entry = entryFor('meetup-pythonsd.ics', { removed: 'organizer request' });
  assert.deepEqual(entry.tags.at(-1), ['removed', 'organizer request']);
});

test('the two headers are list headers under the index key', () => {
  const calendars = eventCalendarsHeader();
  assert.equal(calendars.kind, 39998);
  assert.deepEqual(calendars.tags[0], ['d', 'event-calendars']);
  assert.ok(calendars.tags.some((t) => t[0] === 'required' && t[1] === 'role'));
  const events = eventsHeader();
  assert.deepEqual(events.tags[0], ['d', 'events']);
  assert.deepEqual(events.tags.filter((t) => t[0] === 'item-kind').map((t) => t[1]), ['31923', '31922']);
});
