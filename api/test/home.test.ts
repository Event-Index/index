import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGrid, ringFor, comingUp, cityCounts, type Start } from '../src/home.ts';
import type { EventRow } from '../../indexer/src/store/events.ts';
import type { StoredEntry } from '../../indexer/src/store/directory.ts';

// Thursday 2026-10-15, 18:00 UTC (11:00 in Los Angeles, 14:00 in New York).
const NOW = Date.UTC(2026, 9, 15, 18, 0, 0) / 1000;
const at = (iso: string) => Date.parse(iso) / 1000;

test('the grid is four weeks from the Monday of this week, today and past days marked', () => {
  const grid = dayGrid([], NOW);
  assert.equal(grid.days.length, 28);
  assert.equal(grid.days[0]!.date, '2026-10-12');
  assert.equal(grid.days[27]!.date, '2026-11-08');
  assert.deepEqual(grid.days.slice(0, 4).map((d) => [d.past, d.today]), [[true, false], [true, false], [true, false], [false, true]]);
  assert.ok(grid.days.slice(4).every((d) => !d.past && !d.today));
});

test('an event counts on the date where it happens, in its own zone', () => {
  const starts: Start[] = [
    { start: at('2026-10-17T02:00:00Z'), tzid: 'America/Los_Angeles', allDay: false }, // Fri 16 Oct, 19:00 in LA
    { start: at('2026-10-17T02:00:00Z'), tzid: null, allDay: false }, // Sat 17 Oct in UTC
    { start: at('2026-10-20T00:00:00Z'), tzid: null, allDay: true }, // all-day Tue 20 Oct
    { start: at('2026-10-20T15:00:00Z'), tzid: 'America/New_York', allDay: false },
    { start: at('2026-12-01T15:00:00Z'), tzid: 'America/New_York', allDay: false }, // outside the grid
  ];
  const counts = Object.fromEntries(dayGrid(starts, NOW).days.filter((d) => d.count).map((d) => [d.date, d.count]));
  assert.deepEqual(counts, { '2026-10-16': 1, '2026-10-17': 1, '2026-10-20': 2 });
});

test('today is the earliest current date among the directory\'s zones, so no city is ahead of it', () => {
  // 04:00 UTC on Friday is still Thursday evening in Los Angeles.
  const early = Date.UTC(2026, 9, 16, 4, 0, 0) / 1000;
  const grid = dayGrid([{ start: early + 3600, tzid: 'America/Los_Angeles', allDay: false }], early);
  assert.equal(grid.days.find((d) => d.today)!.date, '2026-10-15');
  assert.equal(dayGrid([], early).days.find((d) => d.today)!.date, '2026-10-16', 'with no zones, UTC');
});

test('a ring grows with the day\'s share of the busiest day\'s events', () => {
  assert.deepEqual([0, 1, 10, 11, 20, 21, 30, 31, 40].map((n) => ringFor(n, 40)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 1, 2].map((n) => ringFor(n, 2)), [0, 2, 4]);
  assert.equal(ringFor(1, 1), 4, 'a lone busy day gets the full ring');
});

const entry = (d: string, location: string | null, name = d): StoredEntry => ({
  d, role: 'calendar', source: 'luma', feedUrl: `https://x/${d}`, pageUrl: null, name, description: null, image: null, location, g: null,
  foundVia: null, addedAt: 0, pubkey: 'ab'.repeat(32), localName: d.replace(/:/g, '-'), removed: null, removedAt: null,
  mode: 'mirrored', owner: null, claimedAt: null, nativeCalendar: null, ownerRelays: [], listed: true,
});
const row = (id: string, calendarD: string, start: number, extra: Partial<EventRow> = {}): EventRow => ({
  id, calendarD, recordId: id, uid: id, d: id, kind: 31923, start, end: null, tzid: 'UTC', title: `Event ${id}`, summary: 'Long description',
  location: null, g: null, tags: [], url: `https://example.org/${id}`, cancelled: false, canonical: null, cohosts: [], ...extra,
});

test('coming up: the soonest events, taken from each city in turn', () => {
  const entries = [entry('a', 'New York, US'), entry('b', 'New York, US'), entry('c', 'Chicago, US'), entry('d', 'Dallas, US')];
  const rows = [
    row('n1', 'a', NOW + 100), row('n2', 'b', NOW + 200), row('n3', 'a', NOW + 300), row('n4', 'b', NOW + 400),
    row('c1', 'c', NOW + 5000), row('c2', 'c', NOW + 6000), row('d1', 'd', NOW + 9000),
    row('x', 'a', NOW + 50, { cancelled: true }), row('copy', 'b', NOW + 60, { canonical: 'n1' }), row('past', 'a', NOW - 100),
  ];
  const picked = comingUp(rows, entries, NOW, 5);
  assert.deepEqual(picked.map((p) => p.row.id), ['n1', 'n2', 'c1', 'c2', 'd1']);
  assert.deepEqual(picked.map((p) => p.city), ['New York', 'New York', 'Chicago', 'Chicago', 'Dallas']);
  assert.equal(picked[0]!.calendar.d, 'a');
});

test('cities with their calendar counts, the largest first, each with its slug', () => {
  const entries = [entry('a', 'New York, US'), entry('b', 'New York, US'), entry('c', 'Chicago, US'), entry('e', null),
    { ...entry('r', 'Chicago, US'), removed: 'organizer request' }];
  const cities = { cities: [{ name: 'New York', slug: 'new-york', country: 'US', geonames_id: 1, latitude: 0, longitude: 0 }, { name: 'Chicago', slug: 'chicago', country: 'US', geonames_id: 2, latitude: 0, longitude: 0 }] };
  assert.deepEqual(cityCounts(entries, cities), [{ name: 'New York', slug: 'new-york', count: 2 }, { name: 'Chicago', slug: 'chicago', count: 1 }]);
});
