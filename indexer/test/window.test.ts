import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed, type NormalizedFeed } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow, type Occurrence } from '../src/project/window.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD, publicEventId } from '../src/project/ids.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const window = projectionWindow(NOW);
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

function feed(fixture: string): NormalizedFeed {
  return normalizeFeed(readFixture(fixture), identify(feedUrlFor(fixture)));
}

function expand(fixture: string, uid: string): Occurrence[] {
  const f = feed(fixture);
  const record = f.records.find((r) => r.uid === uid);
  assert.ok(record, uid);
  return occurrences(record, window, { calendarD: f.context.d, floatingZone: f.calendar.timezone }).items;
}

test('the window runs from 30 days before now to 365 days after', () => {
  assert.deepEqual(window, { from: NOW - 30 * 86400, to: NOW + 365 * 86400 });
});

test('a single event in the window is one occurrence named by its UID', () => {
  const [only, ...rest] = expand('luma-calendar-craftnook.ics', 'evt-PDzqdd9OU1nQXYz@events.lu.ma');
  assert.equal(rest.length, 0);
  assert.equal(only!.d, nostrD('evt-PDzqdd9OU1nQXYz@events.lu.ma'));
  assert.equal(only!.id, publicEventId('luma:cal-BvuRd9eaZnDGBwy', only!.d));
  assert.equal(only!.occurrence, null);
  assert.equal(only!.start, utc(2026, 10, 24, 16));
  assert.equal(only!.end, utc(2026, 10, 24, 20));
  assert.equal(only!.startTzid, null);
});

test('events entirely before the window are not projected', () => {
  assert.equal(expand('luma-calendar-craftnook.ics', 'evt-WnuvM9zwtqOXj95@events.lu.ma').length, 0);
  assert.equal(expand('luma-calendar-craftnook.ics', 'evt-AVAR3ma6MSbXSpC@events.lu.ma').length, 0);
});

test('an event that ends inside the window\'s first day is projected', () => {
  // 2026-09-15 22:30Z, the window opens 2026-09-15 18:00Z
  assert.equal(expand('luma-calendar-craftnook.ics', 'evt-ILpIInTRKRV1pnY@events.lu.ma').length, 1);
});

test('a recurrence expands with EXDATE removed and overrides in their occurrence\'s place', () => {
  const items = expand('synthetic/recurring.ics', 'weekly@fixture.eventindex.space');
  assert.deepEqual(items.map((o) => o.start), [
    utc(2026, 10, 13, 17),
    utc(2026, 10, 21, 18), // the moved occurrence of 20 October
    utc(2026, 11, 3, 18),
    utc(2026, 11, 10, 18), // CET after the change on 25 October
    utc(2026, 11, 17, 18),
  ]);
  assert.equal(items[1]!.event.getFirstPropertyValue('summary'), 'Weekly hack night (moved to Wednesday)');
  assert.equal(items[1]!.d, nostrD('weekly@fixture.eventindex.space', String(utc(2026, 10, 20, 17))));
  assert.equal(items[1]!.occurrence, String(utc(2026, 10, 20, 17)));
  assert.deepEqual(items.map((o) => o.cancelled), [false, false, true, false, false]);
  assert.ok(items.every((o) => o.startTzid === 'Europe/Berlin'));
});

test('RDATE adds occurrences', () => {
  assert.deepEqual(expand('synthetic/recurring.ics', 'rdate@fixture.eventindex.space').map((o) => o.start), [
    utc(2026, 10, 16, 10), utc(2026, 11, 20, 10), utc(2026, 12, 18, 10),
  ]);
});

test('an unbounded rule stops at the end of the window', () => {
  const items = expand('synthetic/recurring.ics', 'daily-unbounded@fixture.eventindex.space');
  assert.equal(items.length, 396);
  assert.equal(items[0]!.startDate, '2026-09-15');
  assert.equal(items.at(-1)!.startDate, '2027-10-15');
  assert.ok(items.every((o) => o.allDay && o.endDate === null));
});

test('an override without its master is an occurrence of its own', () => {
  const [only] = expand('synthetic/recurring.ics', 'orphan@fixture.eventindex.space');
  assert.equal(only!.occurrence, String(utc(2026, 10, 29, 17)));
  assert.equal(only!.start, utc(2026, 10, 29, 18));
});

test('the Kubernetes series skips its EXDATEs and keeps local time across the DST change', () => {
  const items = expand('google-kubernetes-sig-cli.ics', '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com');
  assert.equal(items.length, 26);
  assert.equal(items[0]!.start, utc(2026, 10, 28, 16)); // 09:00 PDT
  assert.equal(items[1]!.start, utc(2026, 11, 11, 17)); // 09:00 PST, the override
  assert.equal(items[0]!.startTzid, 'America/Los_Angeles');
});

test('floating times are read in X-WR-TIMEZONE and flagged', () => {
  const [only] = expand('synthetic/floating.ics', 'floating-1@fixture.eventindex.space');
  assert.equal(only!.start, utc(2026, 10, 21, 0)); // 19:00 CDT
  assert.equal(only!.end, utc(2026, 10, 21, 2));
  assert.equal(only!.floating, true);
  assert.equal(only!.startTzid, 'America/Chicago');
});

test('a UTC time carries the calendar zone when X-WR-TIMEZONE names one', () => {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Lisbon\r\nBEGIN:VEVENT\r\nUID:z@x\r\nDTSTART:20261020T180000Z\r\nSUMMARY:Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const f = normalizeFeed(text, identify('https://fixture.eventindex.space/utc.ics'));
  const [only] = occurrences(f.records[0]!, window, { calendarD: f.context.d, floatingZone: f.calendar.timezone }).items;
  assert.equal(only!.startTzid, 'Europe/Lisbon');
  assert.equal(only!.floating, false);
});

test('floating times without a calendar zone are read as UTC and flagged', () => {
  const [only] = expand('synthetic/floating-no-zone.ics', 'floating-2@fixture.eventindex.space');
  assert.equal(only!.start, utc(2026, 10, 20, 19));
  assert.equal(only!.end, utc(2026, 10, 20, 20, 30));
  assert.equal(only!.floating, true);
  assert.equal(only!.startTzid, null);
});

test('a TZID without VTIMEZONE resolves: IANA, prefixed and alias names', () => {
  const tokyo = expand('synthetic/tzid-without-vtimezone.ics', 'tz-tokyo@fixture.eventindex.space')[0]!;
  assert.equal(tokyo.start, utc(2026, 11, 1, 9));
  assert.equal(tokyo.startTzid, 'Asia/Tokyo');
  const prefixed = expand('synthetic/tzid-without-vtimezone.ics', 'tz-mozilla@fixture.eventindex.space')[0]!;
  assert.equal(prefixed.start, utc(2026, 11, 2, 14));
  assert.equal(prefixed.startTzid, 'America/New_York');
  const alias = expand('synthetic/tzid-without-vtimezone.ics', 'tz-alias@fixture.eventindex.space')[0]!;
  assert.equal(alias.start, utc(2026, 10, 22, 0));
  assert.equal(alias.end, utc(2026, 10, 22, 8));
  assert.equal(alias.startTzid, 'America/Los_Angeles');
  assert.equal(alias.endTzid, 'Europe/London');
});

test('an unknown TZID is read as floating', () => {
  const unknown = expand('synthetic/tzid-without-vtimezone.ics', 'tz-unknown@fixture.eventindex.space')[0]!;
  assert.equal(unknown.floating, true);
  assert.equal(unknown.start, utc(2026, 10, 23, 12));
  assert.equal(unknown.startTzid, null);
});

test('all-day events carry dates, and an end only when the feed gives one', () => {
  const single = expand('synthetic/all-day.ics', 'allday-single@fixture.eventindex.space')[0]!;
  assert.equal(single.allDay, true);
  assert.equal(single.startDate, '2026-10-24');
  assert.equal(single.endDate, null);
  const multi = expand('synthetic/all-day.ics', 'allday-multi@fixture.eventindex.space')[0]!;
  assert.equal(multi.endDate, '2026-11-02');
  const byDuration = expand('synthetic/all-day.ics', 'allday-duration@fixture.eventindex.space')[0]!;
  assert.equal(byDuration.endDate, '2026-12-07');
});

test('expansion reports truncation past its limit', () => {
  const f = feed('synthetic/recurring.ics');
  const record = f.records.find((r) => r.uid === 'daily-unbounded@fixture.eventindex.space')!;
  const result = occurrences(record, window, { calendarD: f.context.d, limit: 10 });
  assert.equal(result.items.length, 10);
  assert.equal(result.truncated, true);
});
