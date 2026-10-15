import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { normalizeFeed, type NormalizedFeed, type EventRecord } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow, type Occurrence } from '../src/project/window.ts';
import { publicCalendar, toIcs, toJcal, toJsonLd, publicContext } from '../src/project/public.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const CHANGED = Date.UTC(2026, 9, 15, 12) / 1000;

function feed(fixture: string): NormalizedFeed {
  return normalizeFeed(readFixture(fixture), identify(feedUrlFor(fixture)));
}
function record(f: NormalizedFeed, uid: string): EventRecord {
  return f.records.find((r) => r.uid === uid)!;
}
function occurrence(f: NormalizedFeed, uid: string, index = 0): Occurrence {
  return occurrences(record(f, uid), projectionWindow(NOW), { calendarD: f.context.d, floatingZone: f.calendar.timezone }).items[index]!;
}
function ics(fixture: string, uid: string, index: number | null = null): { text: string; event: ICAL.Component } {
  const f = feed(fixture);
  const o = index === null ? null : occurrence(f, uid, index);
  const text = toIcs(publicCalendar(record(f, uid), o, publicContext(f, CHANGED)));
  const parsed = new ICAL.Component(ICAL.parse(text));
  return { text, event: parsed.getFirstSubcomponent('vevent')! };
}

test('the public .ics carries no ORGANIZER, ATTENDEE or address', () => {
  const { text, event } = ics('synthetic/rich.ics', 'rich@fixture.eventindex.space');
  assert.ok(!/^ORGANIZER|^ATTENDEE/m.test(text));
  assert.ok(!text.includes('mailto:'));
  const addresses = event.getAllSubcomponents('participant').map((p) => p.getFirstPropertyValue('calendar-address'));
  assert.deepEqual(addresses, ['nostr:npub1gfrzwqlr0puvh83qxpm5djvdpevga9vfs57dj6fcx46g7le3c4uqlhjhjg', null]);
});

test('the public .ics is valid iCalendar with DTSTAMP from the record\'s last change', () => {
  const { text, event } = ics('synthetic/rich.ics', 'rich@fixture.eventindex.space');
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.equal((event.getFirstPropertyValue('dtstamp') as ICAL.Time).toUnixTime(), CHANGED);
  const calendar = new ICAL.Component(ICAL.parse(text));
  assert.equal(calendar.getFirstPropertyValue('name'), 'Rich Calendar');
  assert.ok(calendar.getAllSubcomponents('vtimezone').length === 1);
});

test('an open source keeps its full description and images', () => {
  const { event } = ics('mobilizon-lyontechhub.ics', 'c93acabc-0885-40ca-b861-565079746ed2');
  assert.ok(event.hasProperty('styled-description'));
  assert.equal(event.getFirstProperty('attach')!.getParameter('fmttype'), 'image/jpeg');
  const long = ics('synthetic/malformed.ics', 'long@fixture.eventindex.space').event;
  assert.ok([...new Intl.Segmenter().segment(String(long.getFirstPropertyValue('description')))].length > 280);
});

test('a reserved source serves the summary in place of the description, and no images', () => {
  const { event } = ics('meetup-pythonsd.ics', 'event_312775793@meetup.com');
  const description = String(event.getFirstPropertyValue('description'));
  assert.ok([...new Intl.Segmenter().segment(description)].length <= 280);
  assert.ok(!event.hasProperty('styled-description'));
  const luma = ics('luma-city-nyc.ics', 'evt-8obJGsASb0HxSiX@events.lu.ma').event;
  assert.ok(String(luma.getFirstPropertyValue('description')).startsWith('Unleash your inner ghoulish artist!'));
  assert.ok(!luma.hasProperty('image'));
});

test('a hidden venue has no place in public', () => {
  const { event } = ics('luma-calendar-craftnook.ics', 'evt-BY6CUfvAuCM89l4@events.lu.ma');
  assert.ok(!event.hasProperty('geo') && !event.hasProperty('location'));
  const f = feed('luma-calendar-craftnook.ics');
  assert.equal(toJsonLd(occurrence(f, 'evt-BY6CUfvAuCM89l4@events.lu.ma'), publicContext(f, CHANGED)).location, undefined);
});

test('a hidden venue\'s place is dropped even from a record that still holds one', () => {
  const f = feed('synthetic/rich.ics');
  const r = record(f, 'rich@fixture.eventindex.space');
  r.master!.addPropertyWithValue('geo', [40.1, -73.2]);
  r.master!.addPropertyWithValue('x-eventindex-venue', 'hidden');
  const out = toIcs(publicCalendar(r, null, publicContext(f, CHANGED)));
  assert.ok(!/^GEO|^LOCATION/m.test(out), out);
});

test('an occurrence of a series is served as that one instance', () => {
  const { event } = ics('synthetic/recurring.ics', 'weekly@fixture.eventindex.space', 1);
  assert.ok(!event.hasProperty('rrule') && !event.hasProperty('exdate'));
  assert.equal((event.getFirstPropertyValue('recurrence-id') as ICAL.Time).toUnixTime(), Date.UTC(2026, 9, 20, 17) / 1000);
  assert.equal((event.getFirstPropertyValue('dtstart') as ICAL.Time).toUnixTime(), Date.UTC(2026, 9, 21, 18) / 1000);
  assert.equal(event.getFirstPropertyValue('summary'), 'Weekly hack night (moved to Wednesday)');
});

test('jCal is the same calendar as the .ics', () => {
  const f = feed('synthetic/rich.ics');
  const calendar = publicCalendar(record(f, 'rich@fixture.eventindex.space'), null, publicContext(f, CHANGED));
  assert.equal(JSON.stringify(toJcal(calendar)), JSON.stringify(ICAL.parse(toIcs(calendar))));
});

test('JSON-LD gives local times with their offset, the calendar as organizer and the event page', () => {
  const f = feed('meetup-pythonsd.ics');
  const ld = toJsonLd(occurrence(f, 'event_312775793@meetup.com'), publicContext(f, CHANGED));
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'Event');
  assert.equal(ld.name, 'SDPy Monthly Meetup');
  assert.equal(ld.startDate, '2026-10-22T19:00:00-07:00');
  assert.equal(ld.endDate, '2026-10-22T21:00:00-07:00');
  assert.equal(ld.eventStatus, 'https://schema.org/EventScheduled');
  assert.equal(ld.url, 'https://www.meetup.com/pythonsd/events/312775793/');
  assert.deepEqual(ld.organizer, { '@type': 'Organization', name: 'San Diego Python Users Group', url: 'https://www.meetup.com/pythonsd/' });
  assert.equal(ld.location, undefined);
  assert.ok(String(ld.description).length > 0);
  assert.match(String(ld['@id']), /^https:\/\/api\.eventindex\.space\/api\/1\.0\/events\/byid\/[a-z2-7]{32}$/);
});

test('JSON-LD places a venue with its coordinates, and a URL location online', () => {
  const luma = feed('luma-city-nyc.ics');
  const place = toJsonLd(occurrence(luma, 'evt-8obJGsASb0HxSiX@events.lu.ma'), publicContext(luma, CHANGED));
  assert.deepEqual(place.location, { '@type': 'Place', name: 'Newlab, 19 Morris Ave, Brooklyn, NY 11205, USA', geo: { '@type': 'GeoCoordinates', latitude: 40.6988592, longitude: -73.9747271 } });
  assert.equal(place.startDate, '2026-10-15T21:00:00Z');
  const k8s = feed('google-kubernetes-sig-cli.ics');
  const online = toJsonLd(occurrence(k8s, '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com'), publicContext(k8s, CHANGED));
  assert.deepEqual(online.location, { '@type': 'VirtualLocation', url: 'https://zoom.us/j/288426795' });
  assert.equal(online.eventAttendanceMode, 'https://schema.org/OnlineEventAttendanceMode');
});

test('JSON-LD marks a cancelled event by status, not by its name', () => {
  const f = feed('synthetic/cancelled.ics');
  const ld = toJsonLd(occurrence(f, 'cancelled@fixture.eventindex.space'), publicContext(f, CHANGED));
  assert.equal(ld.name, 'Autumn social');
  assert.equal(ld.eventStatus, 'https://schema.org/EventCancelled');
});

test('JSON-LD gives an all-day event inclusive dates', () => {
  const f = feed('synthetic/all-day.ics');
  const ld = toJsonLd(occurrence(f, 'allday-multi@fixture.eventindex.space'), publicContext(f, CHANGED));
  assert.equal(ld.startDate, '2026-10-30');
  assert.equal(ld.endDate, '2026-11-01');
});

test('a reserved source serves no image and no styled or alternate description, however the feed carries them', () => {
  const text = readFixture('meetup-pythonsd.ics').replace('UID:event_312775793@meetup.com', [
    'UID:event_312775793@meetup.com',
    'IMAGE;VALUE=URI:https://secure.meetupstatic.com/photos/a.jpeg',
    'ATTACH;FMTTYPE=image/jpeg:https://secure.meetupstatic.com/photos/b.jpeg',
    'ATTACH:https://secure.meetupstatic.com/photos/c.png',
    'X-ALT-DESC;FMTTYPE=text/html:<p>Full description</p>',
  ].join('\r\n'));
  const f = normalizeFeed(text, identify(feedUrlFor('meetup-pythonsd.ics')));
  const out = toIcs(publicCalendar(record(f, 'event_312775793@meetup.com'), null, publicContext(f, CHANGED)));
  assert.ok(!/meetupstatic|X-ALT-DESC|Full description/i.test(out), out);
});
