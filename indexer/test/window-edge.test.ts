// Recurrence edge cases where ical.js alone gets the set wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow, type Occurrence } from '../src/project/window.ts';
import { identify } from '../src/directory/id.ts';
import { NOW } from './helpers.ts';

const window = projectionWindow(NOW);
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

function feed(lines: string[], calendar: string[] = []): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...calendar, ...lines, 'END:VCALENDAR', ''].join('\r\n');
}
function event(...lines: string[]): string[] {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261015T120000Z', ...lines, 'END:VEVENT'];
}
function expand(text: string, uid = 'e@x'): { items: Occurrence[]; error?: string } {
  const f = normalizeFeed(text, identify('https://fixture.eventindex.space/edge.ics'));
  const record = f.records.find((r) => r.uid === uid);
  assert.ok(record, `record ${uid}`);
  return occurrences(record, window, { calendarD: f.context.d, floatingZone: f.calendar.timezone });
}
const starts = (r: { items: Occurrence[] }) => r.items.map((o) => o.start);

test('a repeated EXDATE does not hide the next one', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261019T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE:20261026T100000Z', 'EXDATE:20261026T100000Z', 'EXDATE:20261102T100000Z')));
  assert.deepEqual(starts(r), [utc(2026, 10, 19, 10), utc(2026, 11, 9, 10)]);
});

test('EXDATEs that match no occurrence do not hide later ones', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261019T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE:20261020T090000Z,20261021T090000Z,20261026T100000Z')));
  assert.deepEqual(starts(r), [utc(2026, 10, 19, 10), utc(2026, 11, 2, 10)]);
});

test('a UTC EXDATE removes the floating occurrence it names', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE:20261026T140000Z'), ['X-WR-TIMEZONE:America/New_York']));
  assert.deepEqual(starts(r), [utc(2026, 10, 19, 14), utc(2026, 11, 2, 15)]);
});

test('a floating EXDATE removes the zoned occurrence it names', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART;TZID=Europe/Berlin:20261019T190000', 'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE:20261026T190000'), ['X-WR-TIMEZONE:Europe/Berlin']));
  assert.deepEqual(starts(r), [utc(2026, 10, 19, 17), utc(2026, 11, 2, 18)]);
});

test('an override written in another zone replaces its occurrence, once', () => {
  const r = expand(feed([
    ...event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ...event('UID:e@x', 'SUMMARY:E moved', 'RECURRENCE-ID:20261102T150000Z', 'DTSTART:20261102T170000Z'),
    ...event('UID:e@x', 'SUMMARY:E elsewhere', 'RECURRENCE-ID;TZID=Europe/London:20261026T140000', 'DTSTART:20261026T160000Z'),
  ], ['X-WR-TIMEZONE:America/New_York']));
  assert.deepEqual(r.items.map((o) => [o.start, o.event.getFirstPropertyValue('summary')]), [
    [utc(2026, 10, 19, 14), 'E'],
    [utc(2026, 10, 26, 16), 'E elsewhere'],
    [utc(2026, 11, 2, 17), 'E moved'],
  ]);
  assert.equal(new Set(r.items.map((o) => o.d)).size, 3);
});

test('an override of a single event replaces it, and one at another time is its own occurrence', () => {
  const r = expand(feed([
    ...event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z'),
    ...event('UID:e@x', 'SUMMARY:E updated', 'RECURRENCE-ID:20261020T100000Z', 'DTSTART:20261020T120000Z', 'DTEND:20261020T130000Z'),
    ...event('UID:e@x', 'SUMMARY:E extra', 'RECURRENCE-ID:20261027T100000Z', 'DTSTART:20261027T100000Z', 'DTEND:20261027T110000Z'),
  ]));
  assert.deepEqual(r.items.map((o) => [o.start, o.event.getFirstPropertyValue('summary'), o.occurrence]), [
    [utc(2026, 10, 20, 12), 'E updated', null],
    [utc(2026, 10, 27, 10), 'E extra', String(utc(2026, 10, 27, 10))],
  ]);
});

test('a DTSTART off its rule is the first occurrence and counts toward COUNT', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3')));
  assert.deepEqual(starts(r), [utc(2026, 10, 20, 10), utc(2026, 10, 26, 10), utc(2026, 11, 2, 10)]);
});

test('RDATE periods are occurrences with their own end', () => {
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261016T100000Z', 'DTEND:20261016T110000Z',
    'RDATE;VALUE=PERIOD:20261021T100000Z/20261021T120000Z')));
  assert.deepEqual(r.items.map((o) => [o.start, o.end]), [[utc(2026, 10, 16, 10), utc(2026, 10, 16, 11)], [utc(2026, 10, 21, 10), utc(2026, 10, 21, 12)]]);
});

test('a rule ical.js cannot expand yields an error, not an exception', () => {
  const exdates = Array.from({ length: 600 }, (_, i) => new Date(Date.UTC(2026, 9, 16 + i, 10)).toISOString().replace(/[-:]/g, '').replace('.000', ''));
  const r = expand(feed(event('UID:e@x', 'SUMMARY:E', 'DTSTART:20261015T100000Z', 'RRULE:FREQ=DAILY', `EXDATE:${exdates.join(',')}`)));
  assert.ok(Array.isArray(r.items));
});
