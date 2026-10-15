import { test } from 'node:test';
import assert from 'node:assert/strict';
import type ICAL from 'ical.js';
import { normalizeFeed, type NormalizedFeed, type EventRecord } from '../src/normalize/normalize.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD, publicEventId } from '../src/project/ids.ts';
import { readFixture, feedUrlFor } from './helpers.ts';

function normalize(fixture: string, text = readFixture(fixture)): NormalizedFeed {
  const id = identify(feedUrlFor(fixture));
  return normalizeFeed(text, { ...id, calendarAddress: `39999:${'ab'.repeat(32)}:${id.d}` });
}

function record(feed: NormalizedFeed, uid: string): EventRecord {
  const found = feed.records.find((r) => r.uid === uid);
  assert.ok(found, `no record for ${uid}`);
  return found;
}

function names(component: ICAL.Component): string[] {
  return component.getAllProperties().map((p) => p.name);
}

// The record

test('the record keeps the profile properties and drops the rest', () => {
  const event = record(normalize('synthetic/rich.ics'), 'rich@fixture.eventindex.space').master!;
  const kept = names(event);
  for (const name of ['uid', 'summary', 'dtstart', 'dtend', 'description', 'styled-description', 'location', 'url', 'image', 'categories', 'sequence', 'last-modified', 'created', 'organizer', 'x-example-flag']) {
    assert.ok(kept.includes(name), `kept ${name}`);
  }
  for (const name of ['dtstamp', 'class', 'transp', 'contact', 'attendee']) {
    assert.ok(!kept.includes(name), `dropped ${name}`);
  }
  assert.deepEqual(event.getAllSubcomponents().map((c) => c.name), ['vlocation', 'participant', 'participant']);
});

test('the record keeps an e-mail address only on ORGANIZER', () => {
  const event = record(normalize('synthetic/rich.ics'), 'rich@fixture.eventindex.space').master!;
  const addresses = event.getAllSubcomponents('participant').map((p) => p.getFirstPropertyValue('calendar-address'));
  assert.deepEqual(addresses, ['nostr:npub1gfrzwqlr0puvh83qxpm5djvdpevga9vfs57dj6fcx46g7le3c4uqlhjhjg', null]);
  assert.equal(event.getFirstPropertyValue('organizer'), 'mailto:redacted@example.invalid');
});

test('the record keeps DTEND or DURATION as the feed gave it, never both', () => {
  const withDuration = record(normalize('synthetic/floating-no-zone.ics'), 'floating-2@fixture.eventindex.space').master!;
  assert.ok(withDuration.hasProperty('duration'));
  assert.ok(!withDuration.hasProperty('dtend'));
  const withEnd = record(normalize('synthetic/rich.ics'), 'rich@fixture.eventindex.space').master!;
  assert.ok(withEnd.hasProperty('dtend'));
  assert.ok(!withEnd.hasProperty('duration'));
});

test('text values are unescaped', () => {
  const event = record(normalize('synthetic/rich.ics'), 'rich@fixture.eventindex.space').master!;
  assert.equal(event.getFirstPropertyValue('description'), 'Lightning talks about open data.\nBring a laptop.');
  const mobilizon = record(normalize('mobilizon-lyontechhub.ics'), 'c93acabc-0885-40ca-b861-565079746ed2').master!;
  assert.equal(mobilizon.getFirstPropertyValue('location'), 'Tuba lyon Place Charles Béraudier, 69003 Lyon, France, Lyon  Lyon  fr');
});

test('one record per UID holds the master and its overrides', () => {
  const feed = normalize('synthetic/recurring.ics');
  const weekly = record(feed, 'weekly@fixture.eventindex.space');
  assert.ok(weekly.master);
  assert.equal(weekly.overrides.length, 2);
  assert.equal(weekly.component.getAllSubcomponents('vevent').length, 3);
  const orphan = record(feed, 'orphan@fixture.eventindex.space');
  assert.equal(orphan.master, null);
  assert.equal(orphan.overrides.length, 1);
});

test('of two masters with one UID the record keeps the higher SEQUENCE and logs it', () => {
  const feed = normalize('synthetic/malformed.ics');
  assert.equal(record(feed, 'twice@fixture.eventindex.space').master!.getFirstPropertyValue('summary'), 'Current copy');
  assert.ok(feed.log.some((l) => l.code === 'duplicate-uid' && l.uid === 'twice@fixture.eventindex.space'));
});

test('a VEVENT without UID or DTSTART is skipped and logged', () => {
  const feed = normalize('synthetic/malformed.ics');
  assert.ok(!feed.records.some((r) => r.uid === 'no-start@fixture.eventindex.space'));
  assert.ok(feed.log.some((l) => l.code === 'no-start' && l.uid === 'no-start@fixture.eventindex.space'));
  assert.ok(feed.log.some((l) => l.code === 'no-uid'));
});

test('a VEVENT without SUMMARY stays in the record', () => {
  assert.ok(record(normalize('synthetic/malformed.ics'), 'no-summary@fixture.eventindex.space').master);
});

test('each record carries the VTIMEZONE its events use: the feed\'s own or a bundled one', () => {
  const meetup = record(normalize('meetup-pythonsd.ics'), 'event_316721984@meetup.com').component;
  const la = meetup.getAllSubcomponents('vtimezone');
  assert.equal(la.length, 1);
  assert.equal(la[0]!.getFirstPropertyValue('tzid'), 'America/Los_Angeles');
  assert.equal(la[0]!.getFirstPropertyValue('tzurl'), 'http://tzurl.org/zoneinfo-outlook/America/Los_Angeles');
  const paris = record(normalize('mobilizon-lyontechhub.ics'), 'ef6c676c-2ade-4e5a-85c9-9af55b530295').component;
  assert.deepEqual(paris.getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid')), ['Europe/Paris']);
  const luma = record(normalize('luma-calendar-craftnook.ics'), 'evt-PDzqdd9OU1nQXYz@events.lu.ma').component;
  assert.equal(luma.getAllSubcomponents('vtimezone').length, 0);
});

test('an unknown TZID is logged and its times read as floating', () => {
  const feed = normalize('synthetic/tzid-without-vtimezone.ics');
  assert.ok(feed.log.some((l) => l.code === 'unknown-tzid' && l.detail === 'Eastern Standard Time'));
});

test('the index adds X-EVENTINDEX-CALENDAR, -SOURCE and -ID to every VEVENT', () => {
  const feed = normalize('luma-calendar-craftnook.ics');
  const r = record(feed, 'evt-PDzqdd9OU1nQXYz@events.lu.ma');
  const event = r.master!;
  assert.equal(event.getFirstPropertyValue('x-eventindex-calendar'), `39999:${'ab'.repeat(32)}:luma:cal-BvuRd9eaZnDGBwy`);
  assert.equal(event.getFirstPropertyValue('x-eventindex-source'), 'luma');
  assert.equal(event.getFirstPropertyValue('x-eventindex-id'), publicEventId('luma:cal-BvuRd9eaZnDGBwy', nostrD('evt-PDzqdd9OU1nQXYz@events.lu.ma')));
  assert.equal(r.id, event.getFirstPropertyValue('x-eventindex-id'));
});

test('an HTML description moves to STYLED-DESCRIPTION and DESCRIPTION becomes its plain text', () => {
  const event = record(normalize('google-python-events.ics'), '948bb4fe-3cfc-46ac-82ea-b47d34000b6c').master!;
  const styled = event.getFirstProperty('styled-description')!;
  assert.equal(styled.getParameter('fmttype'), 'text/html');
  assert.equal(styled.getFirstValue(), '<a href="https://www.python-summit.ch/">Swiss Python Summit 2026</a>');
  const description = event.getFirstProperty('description')!;
  assert.equal(description.getFirstValue(), 'Swiss Python Summit 2026 (https://www.python-summit.ch/)');
  assert.equal(description.getParameter('derived'), 'TRUE');
});

test('a VALARM and its ATTACH never reach the record', () => {
  const event = record(normalize('google-python-events.ics'), '7nidk5g0g18o83und4dfte4sus@google.com').master!;
  assert.equal(event.getAllSubcomponents('valarm').length, 0);
  assert.ok(!event.hasProperty('attach'));
});

// Calendar metadata

test('the calendar name comes from NAME first', () => {
  const feed = normalize('synthetic/rich.ics');
  assert.equal(feed.calendar.name, 'Rich Calendar');
  assert.equal(feed.calendar.nameSource, 'NAME');
  assert.equal(feed.calendar.description, 'A calendar that uses RFC 7986 and RFC 9073 properties.');
  assert.equal(feed.calendar.url, 'https://example.org/calendar');
  assert.equal(feed.calendar.image, 'https://example.org/logo.png');
  assert.equal(feed.calendar.refreshInterval, 6 * 3600);
});

test('the calendar name falls back to X-WR-CALNAME, then the most frequent organizer, then the entry', () => {
  assert.equal(normalize('luma-calendar-craftnook.ics').calendar.name, 'welcome to the craftnook');
  const mobilizon = normalize('mobilizon-lyontechhub.ics');
  assert.equal(mobilizon.calendar.name, 'Lyon Tech Hub');
  assert.equal(mobilizon.calendar.nameSource, 'ORGANIZER');
  const id = identify(feedUrlFor('synthetic/sequences-none.ics'));
  const bare = normalizeFeed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', { ...id, entryName: 'Entry Name' });
  assert.equal(bare.calendar.name, 'Entry Name');
  assert.equal(bare.calendar.nameSource, 'entry');
});

test('the calendar page comes from the feed URL property, else from the platform id', () => {
  assert.equal(normalize('luma-calendar-craftnook.ics').calendar.url, 'https://luma.com/calendar/cal-BvuRd9eaZnDGBwy');
  assert.equal(normalize('meetup-pythonsd.ics').calendar.url, 'https://www.meetup.com/pythonsd/');
});

test('X-WR-TIMEZONE becomes the calendar zone', () => {
  assert.equal(normalize('google-us-holidays.ics').calendar.timezone, 'Etc/UTC');
  assert.equal(normalize('synthetic/floating.ics').calendar.timezone, 'America/Chicago');
  assert.equal(normalize('luma-city-nyc.ics').calendar.timezone, null);
});

// One bad event must not cost the feed

const cal = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Mixed', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20261015T120000Z', ...lines, 'END:VEVENT'];
const mixed = (text: string) => normalizeFeed(text, identify('https://fixture.eventindex.space/mixed.ics'));

test('a VEVENT ical.js cannot parse is skipped, and the rest of the feed is read', () => {
  const feed = mixed(cal(
    ...ev('UID:bad@x', 'SUMMARY:Bad rule', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=XX'),
    ...ev('UID:good@x', 'SUMMARY:Good', 'DTSTART:20261021T100000Z'),
  ));
  assert.deepEqual(feed.records.map((r) => r.uid), ['good@x']);
  assert.equal(feed.calendar.name, 'Mixed');
  assert.ok(feed.log.some((l) => l.code === 'unparseable-event' && l.uid === 'bad@x'));
});

test('a VEVENT whose DTSTART cannot be read is skipped and logged', () => {
  const feed = mixed(cal(
    ...ev('UID:tba@x', 'SUMMARY:Date to be announced', 'DTSTART:TBA'),
    ...ev('UID:good@x', 'SUMMARY:Good', 'DTSTART:20261021T100000Z'),
  ));
  assert.deepEqual(feed.records.map((r) => r.uid), ['good@x']);
  assert.ok(feed.log.some((l) => l.code === 'bad-value' && l.uid === 'tba@x' && l.detail === 'dtstart'));
});

test('an unreadable EXDATE or DTEND is dropped, and the event kept', () => {
  const feed = mixed(cal(...ev('UID:e@x', 'SUMMARY:E', 'DTSTART:20261021T100000Z', 'DTEND:soon', 'RRULE:FREQ=WEEKLY;COUNT=2', 'EXDATE:never')));
  const event = feed.records[0]!.master!;
  assert.ok(!event.hasProperty('dtend') && !event.hasProperty('exdate'));
  assert.ok(event.hasProperty('rrule'));
  assert.deepEqual(feed.log.filter((l) => l.code === 'bad-value').map((l) => l.detail).sort(), ['dtend', 'exdate']);
});

// Addresses never become names, and a feed cannot write the index's properties

test('an e-mail address is never a calendar name', () => {
  const named = mixed(['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:jane.doe@example.com',
    ...ev('UID:a@x', 'SUMMARY:A', 'DTSTART:20261021T100000Z', 'ORGANIZER;CN=jane.doe@example.com:mailto:jane.doe@example.com'),
    ...ev('UID:b@x', 'SUMMARY:B', 'DTSTART:20261022T100000Z', 'ORGANIZER:events@example.org'),
    'END:VCALENDAR', ''].join('\r\n'));
  assert.equal(named.calendar.name, null);
  const fallback = normalizeFeed(['BEGIN:VCALENDAR', 'VERSION:2.0', ...ev('UID:a@x', 'SUMMARY:A', 'DTSTART:20261021T100000Z', 'ORGANIZER;CN=Club:mailto:x@example.org'), 'END:VCALENDAR', ''].join('\r\n'),
    identify('https://fixture.eventindex.space/x.ics'));
  assert.equal(fallback.calendar.name, 'Club');
});

test('subcomponents keep no address and no index property, and X- properties keep no address', () => {
  const feed = mixed(cal(...ev('UID:e@x', 'SUMMARY:E', 'DTSTART:20261021T100000Z', 'X-CONTACT-EMAIL:mailto:host@example.org', 'X-FLAG:kept',
    'BEGIN:PARTICIPANT', 'UID:p1', 'PARTICIPANT-TYPE:SPEAKER', 'CONTACT:speaker@example.org', 'URL:mailto:speaker@example.org',
    'X-EVENTINDEX-CANONICAL:https://evil.test/', 'DESCRIPTION:Keynote', 'END:PARTICIPANT',
    'BEGIN:VLOCATION', 'UID:l1', 'NAME:Hall', 'X-EVENTINDEX-ID:forged', 'END:VLOCATION')));
  const event = feed.records[0]!.master!;
  const text = JSON.stringify(event.toJSON());
  assert.ok(!text.includes('example.org') && !text.includes('evil.test') && !text.includes('forged'), text);
  assert.equal(event.getFirstPropertyValue('x-flag'), 'kept');
  assert.equal(event.getFirstSubcomponent('participant')!.getFirstPropertyValue('description'), 'Keynote');
});
