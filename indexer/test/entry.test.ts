import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { directoryEntry, eventsHeader } from '../src/directory/entry.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor } from './helpers.ts';

const HEADER = `39998:${'ab'.repeat(32)}:event-calendars`;
// An organizer's verified key, as a calendar's entry names it.
const CAL = 'c1'.repeat(32);

function entryFor(fixture: string, extra: { pubkey?: string | null; removed?: string; location?: string | null; geohash?: string | null; city?: string | null } = {}) {
  const id = identify(feedUrlFor(fixture));
  const feed = normalizeFeed(readFixture(fixture), id);
  return directoryEntry({
    identity: id, calendar: feed.calendar, header: HEADER, pubkey: extra.pubkey === undefined ? CAL : extra.pubkey,
    localName: id.d.toLowerCase().replace(/[^a-z0-9]+/g, '-'), location: extra.location === undefined ? 'San Diego, US' : extra.location,
    geohash: extra.geohash === undefined ? '9mud' : extra.geohash, city: extra.city === undefined ? 'san-diego' : extra.city, removed: extra.removed,
  });
}

test('a Meetup calendar\'s entry, in the header\'s order', () => {
  const entry = entryFor('meetup-pythonsd.ics');
  assert.equal(entry.kind, 39999);
  assert.deepEqual(entry.tags, [
    ['d', 'meetup:pythonsd'],
    ['z', HEADER],
    ['name', 'San Diego Python Users Group'],
    ['role', 'calendar'],
    ['p', CAL],
    ['index-name', 'meetup-pythonsd'],
    ['feed', 'https://www.meetup.com/pythonsd/events/ical/'],
    ['source', 'meetup'],
    ['location', 'San Diego, US'],
    ['g', '9mud'],
    ['meetup-group', 'pythonsd'],
    ['t', 'san-diego'],
    ['t', 'meetup'],
  ]);
  assert.equal(entry.content, '');
});

test('a Luma calendar\'s entry names its Luma id, and never its description or image', () => {
  const entry = entryFor('luma-calendar-craftnook.ics', { location: 'New York, US', geohash: 'dr5r', city: 'new-york' });
  assert.deepEqual(entry.tags.slice(5), [
    ['index-name', 'luma-cal-bvurd9eazndgbwy'],
    ['feed', 'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy'],
    ['source', 'luma'],
    ['location', 'New York, US'],
    ['g', 'dr5r'],
    ['luma-id', 'cal-BvuRd9eaZnDGBwy'],
    ['t', 'new-york'],
    ['t', 'luma'],
  ]);
});

test('an open source\'s entry carries the calendar\'s description and image, last', () => {
  const rich = entryFor('synthetic/rich.ics');
  assert.deepEqual(rich.tags.slice(-4), [
    ['t', 'san-diego'],
    ['t', 'ics'],
    ['description', 'A calendar that uses RFC 7986 and RFC 9073 properties.'],
    ['image', 'https://example.org/logo.png'],
  ]);
  assert.ok(!rich.tags.some((t) => t[0] === 'luma-id' || t[0] === 'meetup-group'));
});

test('an entry has no url and no empty values, and an aggregator has no key', () => {
  const entry = entryFor('luma-city-nyc.ics', { pubkey: null, location: null, geohash: null, city: null });
  assert.deepEqual(entry.tags.find((t) => t[0] === 'role'), ['role', 'aggregator']);
  assert.equal(entry.tags.find((t) => t[0] === 'p'), undefined);
  assert.ok(!entry.tags.some((t) => t[0] === 'url'));
  assert.ok(entry.tags.every((t) => t.length >= 2 && t.slice(1).every((v) => v !== '')));
  assert.deepEqual(entry.tags.filter((t) => t[0] === 't'), [['t', 'luma']]);
});

test('a retired entry is republished with removed and its reason', () => {
  const entry = entryFor('meetup-pythonsd.ics', { removed: 'organizer request' });
  assert.deepEqual(entry.tags.at(-1), ['removed', 'organizer request']);
});

test('the events header stays a list header under the index key', () => {
  const events = eventsHeader();
  assert.deepEqual(events.tags[0], ['d', 'events']);
  assert.deepEqual(events.tags.filter((t) => t[0] === 'item-kind').map((t) => t[1]), ['31923', '31922']);
});

const OWNER = 'a0'.repeat(32);

test('a native calendar\'s entry names its author and its calendar, and no feed', () => {
  const d = `nostr:${OWNER}`;
  const entry = directoryEntry({
    identity: { d, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: 'https://example.org' },
    calendar: { name: 'Lakeside Bitcoin Club', nameSource: 'entry', platformDefault: false, description: 'Monthly meetups.', url: 'https://example.org', image: 'https://example.org/p.png', color: null, refreshInterval: null, timezone: null },
    header: HEADER, pubkey: OWNER, localName: 'nostr-a0a0a0a0a0a0a0a0', location: 'Chicago, US', geohash: 'dp3w', city: 'chicago',
    nativeCalendar: `31924:${OWNER}:main`,
  });
  assert.deepEqual(entry.tags, [
    ['d', d],
    ['z', HEADER],
    ['name', 'Lakeside Bitcoin Club'],
    ['role', 'calendar'],
    ['p', OWNER],
    ['index-name', 'nostr-a0a0a0a0a0a0a0a0'],
    ['source', 'nostr'],
    ['location', 'Chicago, US'],
    ['g', 'dp3w'],
    ['calendar', `31924:${OWNER}:main`],
    ['t', 'chicago'],
    ['t', 'nostr'],
    ['description', 'Monthly meetups.'],
    ['image', 'https://example.org/p.png'],
  ]);
});

test('a calendar claimed to publish itself is read from nostr, and names its organizer\'s key', () => {
  const id = identify(feedUrlFor('luma-calendar-craftnook.ics'));
  const feed = normalizeFeed(readFixture('luma-calendar-craftnook.ics'), id);
  const entry = directoryEntry({
    identity: id, calendar: feed.calendar, header: HEADER, pubkey: OWNER, readFrom: 'nostr',
    localName: 'luma-cal-bvurd9eazndgbwy', location: 'New York, US', geohash: 'dr5r', city: 'new-york',
  });
  assert.deepEqual(entry.tags.filter((t) => t[0] === 'p'), [['p', OWNER]]);
  assert.equal(entry.tags.find((t) => t[0] === 'source')![1], 'nostr');
  assert.equal(entry.tags.find((t) => t[0] === 'feed'), undefined, 'the feed is no longer read');
  assert.deepEqual(entry.tags.find((t) => t[0] === 'luma-id'), ['luma-id', 'cal-BvuRd9eaZnDGBwy'], 'its Luma link stays');
  assert.deepEqual(entry.tags.filter((t) => t[0] === 't'), [['t', 'new-york'], ['t', 'nostr']]);
});

test('a calendar published for its organizer, as them, keeps its feed and names their calendar', () => {
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  const feed = normalizeFeed(readFixture('meetup-pythonsd.ics'), id);
  const entry = directoryEntry({
    identity: id, calendar: feed.calendar, header: HEADER, pubkey: OWNER, localName: 'meetup-pythonsd',
    nativeCalendar: `31924:${OWNER}:meetup:pythonsd`,
  });
  assert.deepEqual(entry.tags.filter((t) => t[0] === 'p'), [['p', OWNER]]);
  assert.equal(entry.tags.find((t) => t[0] === 'source')![1], 'meetup');
  assert.equal(entry.tags.find((t) => t[0] === 'feed')![1], 'https://www.meetup.com/pythonsd/events/ical/');
  assert.deepEqual(entry.tags.find((t) => t[0] === 'calendar'), ['calendar', `31924:${OWNER}:meetup:pythonsd`]);
});
