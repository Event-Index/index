import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGeohash, encodeGeohash } from '../src/project/geohash.ts';
import { coverage, formatCoverage, referenceOf, titlesMatch, upcomingReferences, venuesMatch, type Reference } from '../src/service/coverage.ts';
import type { City } from '../src/service/admin.ts';
import { eventStore, type EventRow } from '../src/store/events.ts';
import { openIndexDb } from '../src/store/index-db.ts';
import { NOW } from './helpers.ts';

const NYC: City = { name: 'New York', slug: 'new-york', country: 'US', geonames_id: 5128581, latitude: 40.71427, longitude: -74.00597, timezone: 'America/New_York' };
const AUSTIN: City = { name: 'Austin', slug: 'austin', country: 'US', geonames_id: 4671654, latitude: 30.26715, longitude: -97.74306, timezone: 'America/Chicago' };
const START = NOW + 5 * 86400;

function ref(extra: Partial<Reference> = {}): Reference {
  return { id: 'r1', title: 'Bitcoin & Coffee', start: START, tzid: 'America/New_York', location: 'Joe Coffee, 9 E 13th St, New York, NY', lat: 40.7350, lon: -73.9930, link: 'https://example.org/e/1', ...extra };
}

function row(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: 'e1', calendarD: 'meetup:nycbitcoin', recordId: 'x', uid: 'u', d: 'd', kind: 31923, start: START, end: START + 7200, tzid: 'America/New_York',
    title: 'Bitcoin and Coffee', summary: null, location: 'Joe Coffee (9 E 13th St)', g: encodeGeohash(40.7351, -73.9931, 9), tags: [], url: null,
    cancelled: false, canonical: null, cohosts: [], ...extra,
  };
}

test('a geohash decodes to the centre of its cell', () => {
  const [lat, lon] = decodeGeohash(encodeGeohash(40.71427, -74.00597, 9))!;
  assert.ok(Math.abs(lat - 40.71427) < 0.0001 && Math.abs(lon + 74.00597) < 0.0001);
  assert.equal(decodeGeohash('not a hash'), null);
});

test('a NIP-52 event becomes a reference with its title, start, place and link', () => {
  const r = referenceOf({
    id: 'abc', kind: 31923, content: 'Join us',
    tags: [['d', 'x'], ['title', 'Social Hour'], ['start', String(START)], ['start_tzid', 'America/Detroit'], ['location', 'TwoGuys Brewing, Wyoming, MI'],
      ['g', encodeGeohash(42.9, -85.7, 9)], ['r', 'https://example.org/e/2']],
  })!;
  assert.equal(r.title, 'Social Hour');
  assert.equal(r.start, START);
  assert.equal(r.tzid, 'America/Detroit');
  assert.equal(r.location, 'TwoGuys Brewing, Wyoming, MI');
  assert.ok(Math.abs(r.lat! - 42.9) < 0.001);
  assert.equal(r.link, 'https://example.org/e/2');
  assert.equal(referenceOf({ id: 'n', kind: 31923, content: '', tags: [['title', 'No start']] }), null);
});

test('titles match once normalized, or when one holds the other', () => {
  assert.ok(titlesMatch('Bitcoin & Coffee', 'bitcoin and coffee!'));
  assert.ok(titlesMatch('Bitcoin & Coffee (Laughing Bean Coffee Co)', 'Bitcoin & Coffee'));
  assert.ok(titlesMatch('Café Satoshi', 'Cafe Satoshi'));
  assert.ok(!titlesMatch('Bitcoin & Coffee', 'Python Night'));
  assert.ok(!titlesMatch('Meetup', 'Meetup at the Library of Things'), 'a single short word is not enough');
});

test('venues match by name, or by coordinates a few hundred metres apart', () => {
  assert.ok(venuesMatch(ref(), row()));
  assert.ok(venuesMatch(ref({ location: 'Somewhere else' }), row()), 'close coordinates');
  assert.ok(venuesMatch(ref({ lat: null, lon: null }), row({ g: null })), 'the same venue name');
  assert.ok(!venuesMatch(ref({ location: 'Other Bar', lat: 40.80, lon: -73.95 }), row()));
});

test('coverage counts, per city, the references the index holds and lists the misses', () => {
  const refs = [
    ref(),
    ref({ id: 'r2', title: 'Bitcoin Pleb Night', location: 'Other Bar, New York', lat: 40.75, lon: -73.98, link: 'https://example.org/e/3' }),
    ref({ id: 'r3', title: 'Austin Bitcoin Devs', tzid: 'America/Chicago', location: 'Capital Factory', lat: 30.268, lon: -97.740, link: null }),
    ref({ id: 'r4', title: 'Far away', lat: 52.52, lon: 13.40 }),
    ref({ id: 'r5', title: 'No place', lat: null, lon: null }),
  ];
  const near = (from: number, to: number) => [
    row(),
    row({ id: 'e2', title: 'Bitcoin Pleb Night', start: START + 3600, location: 'Other Bar' }),
    // The same title and time, but in another city.
    row({ id: 'e3', title: 'Austin Bitcoin Devs', location: 'Joe Coffee', g: encodeGeohash(40.7351, -73.9931, 9) }),
  ].filter((r) => r.start <= to && (r.end ?? r.start) >= from);
  const report = coverage(refs, [NYC, AUSTIN], near, () => null);
  assert.equal(report.total, 5);
  assert.equal(report.elsewhere, 1);
  assert.equal(report.unplaced, 1);
  const nyc = report.cities.find((c) => c.city.slug === 'new-york')!;
  assert.equal(nyc.total, 2);
  assert.equal(nyc.held, 1);
  assert.deepEqual(nyc.misses.map((m) => m.id), ['r2']);
  const austin = report.cities.find((c) => c.city.slug === 'austin')!;
  assert.deepEqual([austin.total, austin.held], [1, 0]);

  const text = formatCoverage(report, { source: 'npub1test', relay: 'wss://relay.test', now: NOW }).join('\n');
  assert.match(text, /1 of 3 upcoming events in the index's cities \(33%\)/);
  assert.match(text, /New York\s+1 of 2\s+50%/);
  assert.match(text, /Austin\s+0 of 1\s+0%/);
  assert.match(text, /Bitcoin Pleb Night — Other Bar, New York — https:\/\/example.org\/e\/3/);
  assert.match(text, /Austin Bitcoin Devs — Capital Factory$/m);
});

test('an event without coordinates in the index is placed by its calendar\'s area', () => {
  const near = () => [row({ g: null, location: null, title: 'Bitcoin & Coffee' })];
  const held = coverage([ref()], [NYC], near, () => [40.71, -74.0]);
  assert.equal(held.cities[0]!.held, 1);
  const elsewhere = coverage([ref()], [NYC], near, () => [30.27, -97.74]);
  assert.equal(elsewhere.cities[0]!.held, 0);
});

test('a publisher\'s upcoming events are read page by page, the newest version of each', async () => {
  const pk = 'ab'.repeat(32);
  const all = Array.from({ length: 12 }, (_, i) => ({
    id: `id${i}`, kind: 31923, pubkey: pk, created_at: i + 1, content: '',
    tags: [['d', i === 11 ? 'e0' : `e${i}`], ['title', `Event ${i}`], ['start', String(i === 3 ? NOW - 60 : NOW + 3600 * (i + 1))]],
  }));
  const filters: Array<{ until?: number }> = [];
  // A relay that answers at most five events, the newest first.
  const query = async (filter: { until?: number }) => {
    filters.push(filter);
    return all.filter((e) => filter.until === undefined || e.created_at <= filter.until).sort((a, b) => b.created_at - a.created_at).slice(0, 5);
  };
  const refs = await upcomingReferences(query, pk, NOW);
  assert.ok(filters.length >= 3);
  // Twelve events: one is past, and e0 has a newer version (Event 11).
  assert.equal(refs.length, 10);
  assert.ok(refs.some((r) => r.title === 'Event 11'));
  assert.ok(!refs.some((r) => r.title === 'Event 0' || r.title === 'Event 3'));
});

test('the publisher\'s own events in the index do not count as held', () => {
  const own = row({ calendarD: `nostr:${'ab'.repeat(32)}` });
  const near = () => [own];
  assert.equal(coverage([ref()], [NYC], near, () => null).cities[0]!.held, 1);
  const report = coverage([ref()], [NYC], near, () => null, { ignore: (r) => r.calendarD === `nostr:${'ab'.repeat(32)}` });
  assert.equal(report.cities[0]!.held, 0);
});

test('the events starting in a span are found however many long events overlap it', () => {
  const index = openIndexDb(':memory:');
  const events = eventStore(index);
  const long = Array.from({ length: 600 }, (_, i) => row({ id: `long${i}`, calendarD: 'nostr:long', title: `Course ${i}`, start: START - 30 * 86400, end: START + 30 * 86400 }));
  events.replaceCalendar('nostr:long', long);
  events.replaceCalendar('meetup:nycbitcoin', [row(), row({ id: 'later', start: START + 3600 })]);
  assert.deepEqual(events.startingBetween(START - 900, START + 900).map((r) => r.id), ['e1']);
  assert.equal(events.search({ from: START - 900, to: START + 900, limit: 500 }).some((r) => r.id === 'e1'), false, 'an overlap search is crowded out');
});
