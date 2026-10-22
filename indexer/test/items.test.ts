import { calendarPolicy } from '../src/adapters/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventItem, whenText, zoneFor, type ItemCalendar } from '../src/project/items.ts';
import type { EventRow } from '../src/store/events.ts';
import type { Cities } from '../src/service/admin.ts';

const cities = (JSON.parse(readFileSync(new URL('../../seeds/cities.json', import.meta.url), 'utf8')) as Cities).cities;
const INDEX = 'cb'.repeat(32);
const HEADER = `39998:${'ab'.repeat(32)}:events`;

function row(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: 'fdxbx3kbt4gjkychakq3vlz4mhikvpj4', calendarD: 'luma:cal-dlSUfDiWBlONmiQ', recordId: 'r', uid: 'evt-1@events.lu.ma', d: 'x', kind: 31923,
    start: 1793223000, end: 1793232000, tzid: null, title: 'Liberty Pub Live: Jack Hunter, Jim Antle, Matt Kibbe at PubKey DC', summary: null,
    location: 'Pubkey, 410 7th St NW, Washington, DC 20004, USA', g: 'dqcjr2dhg', tags: [], url: 'https://luma.com/pubkey-ldkz',
    cancelled: false, canonical: null, cohosts: [], ...extra,
  };
}

const pubkey: ItemCalendar = { d: 'luma:cal-dlSUfDiWBlONmiQ', name: 'PubKey Bitcoin Events', source: 'luma', feedUrl: 'https://api.luma.com/ics/get?entity=calendar&id=cal-dlSUfDiWBlONmiQ', location: 'New York, US', owner: null };

function item(r: EventRow, calendar: ItemCalendar = pubkey, image: string | null = null): string[][] {
  const built = eventItem(r, { header: HEADER, indexPubkey: INDEX, calendar, cities, image, policy: calendarPolicy(calendar) });
  assert.ok('template' in built, JSON.stringify(built));
  assert.equal(built.template.kind, 39999);
  assert.equal(built.template.content, '');
  return built.template.tags;
}
const tag = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1];

test('a Luma evening becomes the item the review checked', () => {
  // candidates.json, item 1: the venue's zone, the calendar's city as topic.
  assert.deepEqual(item(row()), [
    ['d', 'fdxbx3kbt4gjkychakq3vlz4mhikvpj4'],
    ['z', HEADER],
    ['title', 'Liberty Pub Live: Jack Hunter, Jim Antle, Matt Kibbe at PubKey DC'],
    ['start', '1793223000'],
    ['end', '1793232000'],
    ['when', 'Wed 28 Oct 2026, 5:30 PM-8:00 PM EDT'],
    ['start_tzid', 'America/New_York'],
    ['organizer', 'PubKey Bitcoin Events'],
    ['calendar', `39999:${INDEX}:luma:cal-dlSUfDiWBlONmiQ`],
    ['source', 'luma'],
    ['location', 'Pubkey, 410 7th St NW, Washington, DC 20004, USA'],
    ['g', 'dqcjr2dhg'],
    ['luma-slug', 'pubkey-ldkz'],
    ['index-id', 'fdxbx3kbt4gjkychakq3vlz4mhikvpj4'],
    ['t', 'new-york'],
    ['t', 'luma'],
    ['i', 'https://luma.com/pubkey-ldkz'],
    ['k', 'web'],
    ['expiration', '1795824000'],
    ['alt', 'PubKey Bitcoin Events: Liberty Pub Live: Jack Hunter, Jim Antle, Matt Kibbe at PubKey DC'],
  ]);
});

test('a Meetup event keeps its feed\'s zone and its group and number for the link', () => {
  const tags = item(row({ id: 'yvu6aighoyslw35yaou3itsivmeg5ha3', start: 1792620000, end: 1792627200, tzid: 'America/New_York', title: 'BitPlebs Bitcoin Meetup @ ATL BitLab',
    location: null, g: null, summary: 'Join us at ATL BitLab.', url: 'https://www.meetup.com/atlantabitdevs/events/315045013/' }),
  { d: 'meetup:atlantabitdevs', name: 'Atlanta Bitcoin Community', source: 'meetup', feedUrl: 'https://www.meetup.com/atlantabitdevs/events/ical/', location: 'Atlanta, US', owner: null });
  assert.equal(tag(tags, 'when'), 'Wed 21 Oct 2026, 6:00 PM-8:00 PM EDT');
  assert.equal(tag(tags, 'start_tzid'), 'America/New_York');
  assert.equal(tag(tags, 'meetup-group'), 'atlantabitdevs');
  assert.equal(tag(tags, 'meetup-event'), '315045013');
  assert.equal(tag(tags, 'summary'), 'Join us at ATL BitLab.');
  assert.equal(tag(tags, 'url'), undefined, 'the source has a link of its own');
  assert.equal(tag(tags, 'location'), undefined);
  assert.equal(tag(tags, 'expiration'), '1795219200');
});

test('two days in another city: the venue\'s zone, written from start to end', () => {
  const tags = item(row({ start: 1789556400, end: 1789682400, location: 'Café Paper Hill, 1030 Rue St-Alexandre, Montreal, QC H2Z 1E3, Canada', g: 'f25dy58fs', url: 'https://luma.com/click-cafe-all-in-2026' }),
    { ...pubkey, name: 'ClickHouse Events', location: 'Austin, US' });
  assert.equal(tag(tags, 'start_tzid'), 'America/Toronto');
  assert.equal(tag(tags, 'when'), 'Wed 16 Sep, 7:00 AM to Thu 17 Sep 2026, 6:00 PM EDT');
  assert.deepEqual(tags.filter((t) => t[0] === 't').map((t) => t[1]), ['austin', 'luma']);
});

test('a hidden venue has no place, and takes the calendar\'s city\'s zone', () => {
  const tags = item(row({ start: 1789601400, end: 1789606800, location: null, g: null, url: 'https://luma.com/summerwinddown2026' }));
  assert.equal(tag(tags, 'start_tzid'), 'America/New_York');
  assert.equal(tag(tags, 'when'), 'Wed 16 Sep 2026, 7:30 PM-9:00 PM EDT');
  assert.equal(tag(tags, 'location'), undefined);
  assert.equal(tag(tags, 'g'), undefined);
});

test('an all-day event of several days is written with dates, its end the day after its last', () => {
  const start = Date.UTC(2026, 9, 19) / 1000;
  const tags = item(row({ kind: 31922, start, end: Date.UTC(2026, 9, 25) / 1000, location: 'Ehrengutstraße 16, München', g: 'u281z04jc', url: 'https://luma.com/nsh51of4' }),
    { ...pubkey, name: 'Munich Climate Week', location: 'Munich, DE' });
  assert.equal(tag(tags, 'start'), '2026-10-19');
  assert.equal(tag(tags, 'end'), '2026-10-25');
  assert.equal(tag(tags, 'when'), 'Mon 19 Oct to Sat 24 Oct 2026');
  assert.equal(tag(tags, 'start_tzid'), undefined, 'a date has no zone');
  assert.equal(tag(tags, 'expiration'), '1795478400');
});

test('a time in central Europe names its zone as people know it', () => {
  const tags = item(row({ start: 1792389600, end: 1792443600, tzid: null, location: 'Thalkirchner Straße 207, 81371 München', g: null, url: 'https://luma.com/mcw2026-mzbg' }),
    { ...pubkey, name: 'Munich Climate Week', location: 'Munich, DE' });
  assert.equal(tag(tags, 'start_tzid'), 'Europe/Berlin');
  assert.equal(tag(tags, 'when'), 'Mon 19 Oct 2026, 8:00 AM-11:00 PM CEST');
});

test('a copy of another calendar\'s or an organizer\'s own event, and an event over 92 days, get no item', () => {
  const ctx = { header: HEADER, indexPubkey: INDEX, calendar: pubkey, cities, image: null };
  assert.deepEqual(eventItem(row({ canonical: 'mctso6durbhz6aad2luahvvg5kga7bzn' }), ctx), { skip: 'copy' });
  assert.deepEqual(eventItem(row({ start: 1789000000, end: 1789000000 + 93 * 86400 }), ctx), { skip: 'longer-than-92-days' });
  // Five weeks is listed.
  assert.ok('template' in eventItem(row({ kind: 31922, start: Date.UTC(2026, 8, 15) / 1000, end: Date.UTC(2026, 9, 23) / 1000 }), ctx));
});

test('a cancelled event says so in its status and its title', () => {
  const tags = item(row({ cancelled: true }));
  assert.equal(tag(tags, 'status'), 'cancelled');
  assert.equal(tag(tags, 'title'), 'Cancelled: Liberty Pub Live: Jack Hunter, Jim Antle, Matt Kibbe at PubKey DC');
});

test('an organizer who verified their key is named on each item as its host', () => {
  const owner = 'ee'.repeat(32);
  assert.deepEqual(item(row(), { ...pubkey, owner }).filter((t) => t[0] === 'p'), [['p', owner]]);
  assert.deepEqual(item(row()).filter((t) => t[0] === 'p'), []);
});

test('a feed elsewhere is named by its host and links its page; its image comes only once its organizer has verified', () => {
  const calendar: ItemCalendar = { d: 'ics:abc', name: 'Lyon Tech Hub', source: 'ics', feedUrl: 'https://events.example.org/feed.ics', location: 'Lyon, FR', owner: null };
  const event = row({ url: 'https://events.example.org/e/1', g: null, location: 'La Cordée', tzid: 'Europe/Paris' });
  const tags = item(event, calendar, 'https://events.example.org/e/1.png');
  assert.equal(tag(tags, 'source'), 'events.example.org');
  assert.equal(tag(tags, 'url'), 'https://events.example.org/e/1');
  assert.equal(tag(tags, 'image'), undefined, 'summary and link until verified');
  assert.equal(tag(item(event, { ...calendar, owner: 'ab'.repeat(32) }, 'https://events.example.org/e/1.png'), 'image'), 'https://events.example.org/e/1.png');
  assert.equal(tag(tags, 'luma-slug'), undefined);
  // A Luma event never carries an image.
  assert.equal(tag(item(row(), pubkey, 'https://images.lumacdn.com/x.png'), 'image'), undefined);
});

test('an event with no end expires 30 days after its start, and is written with its start only', () => {
  const tags = item(row({ end: null }));
  assert.equal(tag(tags, 'end'), undefined);
  assert.equal(tag(tags, 'when'), 'Wed 28 Oct 2026, 5:30 PM EDT');
  assert.equal(tag(tags, 'expiration'), String(1793223000 + 30 * 86400));
});

test('the zone comes from the feed, then the boundaries at the venue, then the calendar\'s city, then UTC', () => {
  assert.equal(zoneFor('Europe/Paris', 'dqcjr2dhg', 'New York, US', cities), 'Europe/Paris');
  assert.equal(zoneFor(null, 'dqcjr2dhg', 'New York, US', cities), 'America/New_York');
  // Venues far from their calendar's city, and from any seeded city.
  assert.equal(zoneFor(null, 'u6sce0t4h', 'Istanbul, TR', cities), 'Europe/Stockholm');
  assert.equal(zoneFor(null, 'wdw0v5jvh', 'Istanbul, TR', cities), 'Asia/Manila');
  assert.equal(zoneFor(null, 'e9rtkcumt', 'Auckland, NZ', cities), 'Africa/Freetown');
  assert.equal(zoneFor(null, 'u0qvtxjtn', 'Istanbul, TR', cities), 'Europe/Vienna');
  // A venue at sea.
  assert.equal(zoneFor(null, 'kzzzzzzzz', 'Austin, US', cities), 'America/Chicago');
  assert.equal(zoneFor(null, null, 'Nowhere, ZZ', cities), 'UTC');
});

test('Dev Days in Stockholm, from a calendar elsewhere, is written in Stockholm\'s time', () => {
  const tags = item(row({ start: 1792600200, end: 1792618200, location: 'Kungsgatan 1, Stockholm', g: 'u6sce0t4h', url: 'https://luma.com/devdays-sthlm' }),
    { ...pubkey, name: 'Dev Days', location: 'Istanbul, TR' });
  assert.equal(tag(tags, 'start_tzid'), 'Europe/Stockholm');
  assert.equal(tag(tags, 'when'), 'Wed 21 Oct 2026, 6:30 PM-11:30 PM CEST');
});

test('the "when" text of an all-day event of one day, and of one across years', () => {
  assert.equal(whenText({ start: Date.UTC(2026, 9, 28) / 1000, end: Date.UTC(2026, 9, 29) / 1000, allDay: true, zone: 'UTC' }), 'Wed 28 Oct 2026, all day');
  assert.equal(whenText({ start: Date.UTC(2026, 11, 30) / 1000, end: Date.UTC(2027, 0, 3) / 1000, allDay: true, zone: 'UTC' }), 'Wed 30 Dec 2026 to Sat 2 Jan 2027');
});

test('a Meetup event of a series, whose number is letters, still links to its page', () => {
  const tags = item(row({ url: 'https://www.meetup.com/bitcoin-and-beer/events/zpskwtykcjbpb/' }),
    { d: 'meetup:bitcoin-and-beer', name: 'Bitcoin & Beer', source: 'meetup', feedUrl: 'https://www.meetup.com/bitcoin-and-beer/events/ical/', location: 'Denver, US', owner: null });
  assert.equal(tag(tags, 'meetup-group'), 'bitcoin-and-beer');
  assert.equal(tag(tags, 'meetup-event'), 'zpskwtykcjbpb');
});
