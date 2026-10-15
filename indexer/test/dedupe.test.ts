import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow } from '../src/project/window.ts';
import { resolveCohosts, listingsOf, type Listing } from '../src/rules/dedupe.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

function listings(fixture: string): Listing[] {
  const feed = normalizeFeed(readFixture(fixture), identify(feedUrlFor(fixture)));
  return listingsOf(feed, (record) => occurrences(record, projectionWindow(NOW), { calendarD: feed.context.d, floatingZone: feed.calendar.timezone }).items);
}

function groupOf(resolutions: ReturnType<typeof resolveCohosts>, uid: string) {
  return resolutions.find((r) => r.canonical.uid === uid || r.duplicates.some((l) => l.uid === uid));
}

test('two calendars listing the same UID are one event with a co-host', () => {
  const all = [...listings('luma-calendar-craftnook.ics'), ...listings('luma-calendar-journaling.ics')];
  const group = groupOf(resolveCohosts(all), 'evt-ILpIInTRKRV1pnY@events.lu.ma')!;
  // Neither calendar's name is the organizer's CN ("craftnook"), so the lowest d signs.
  assert.equal(group.canonical.calendarD, 'luma:cal-BvuRd9eaZnDGBwy');
  assert.deepEqual(group.cohosts, ['luma:cal-f6iLyfD3TN5qUO2']);
  assert.equal(group.duplicates.length, 1);
  assert.equal(group.duplicates[0]!.calendarD, 'luma:cal-f6iLyfD3TN5qUO2');
});

test('the calendar named like the event\'s organizer signs, whatever its d', () => {
  const all = [...listings('synthetic/cohost-url-a.ics'), ...listings('synthetic/cohost-url-b.ics')];
  const [group, ...rest] = resolveCohosts(all);
  assert.equal(rest.length, 0, 'the same URL and start make one event');
  assert.equal(group!.canonical.calendarName, 'Transit Riders Union');
  assert.equal(group!.cohosts.length, 1);
});

test('co-host resolution does not depend on input order', () => {
  const all = [...listings('luma-calendar-craftnook.ics'), ...listings('luma-calendar-journaling.ics'), ...listings('synthetic/cohost-url-a.ics'), ...listings('synthetic/cohost-url-b.ics')];
  const key = (rs: ReturnType<typeof resolveCohosts>) => JSON.stringify(rs.map((r) => [r.canonical.calendarD, r.canonical.uid, r.cohosts]).sort());
  assert.equal(key(resolveCohosts(all)), key(resolveCohosts([...all].reverse())));
});

test('the same UID at different starts is not merged', () => {
  const base: Listing = { calendarD: 'ics:a', calendarName: 'A', uid: '1@example.org', url: null, start: NOW + 3600, organizer: null, d: 'x', id: 'i1' };
  const other: Listing = { ...base, calendarD: 'ics:b', calendarName: 'B', start: NOW + 7200, id: 'i2' };
  assert.equal(resolveCohosts([base, other]).length, 2);
});

test('an event listed by one calendar has no co-hosts', () => {
  const resolutions = resolveCohosts(listings('meetup-pythonsd.ics'));
  assert.equal(resolutions.length, 4);
  assert.ok(resolutions.every((r) => r.cohosts.length === 0 && r.duplicates.length === 0));
});
