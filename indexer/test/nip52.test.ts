import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed, type NormalizedFeed } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow, type Occurrence } from '../src/project/window.ts';
import { projectOccurrence, projectionContext, type ProjectionContext, type EventTemplate } from '../src/project/nip52.ts';
import { projectionHash } from '../src/project/hash.ts';
import { encodeGeohash } from '../src/project/geohash.ts';
import { nostrD } from '../src/project/ids.ts';
import { summarize } from '../src/ical/text.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const CAL = 'c1'.repeat(32);
const COHOST = 'c2'.repeat(32);
const INDEX = 'e1'.repeat(32);
const SPEAKER = '42462703e37878cb9e20307746c98d0e588e9589853cd9693835748f7f31c578';
const RELAY = 'wss://relay.eventindex.space';

function feed(fixture: string, text = readFixture(fixture)): NormalizedFeed {
  return normalizeFeed(text, identify(feedUrlFor(fixture)));
}

function occurrencesOf(f: NormalizedFeed, uid: string): Occurrence[] {
  const record = f.records.find((r) => r.uid === uid);
  assert.ok(record, uid);
  return occurrences(record, projectionWindow(NOW), { calendarD: f.context.d, floatingZone: f.calendar.timezone }).items;
}

function context(f: NormalizedFeed, extra: Partial<ProjectionContext> = {}): ProjectionContext {
  return { ...projectionContext(f, { calendarPubkey: CAL, indexPubkey: INDEX }), ...extra };
}

function project(fixture: string, uid: string, options: { text?: string; index?: number; extra?: Partial<ProjectionContext> } = {}): { t: EventTemplate; o: Occurrence } {
  const f = feed(fixture, options.text);
  const o = occurrencesOf(f, uid)[options.index ?? 0];
  assert.ok(o, `occurrence of ${uid}`);
  const result = projectOccurrence(o, context(f, options.extra));
  assert.ok('template' in result, `projected ${uid}`);
  return { t: result.template, o };
}

const all = (t: EventTemplate, name: string) => t.tags.filter((x) => x[0] === name);
const one = (t: EventTemplate, name: string) => {
  const found = all(t, name);
  assert.ok(found.length <= 1, `one ${name}`);
  return found[0];
};

const LUMA_CITY = 'luma-city-nyc.ics';
const CRAFTNOOK = 'luma-calendar-craftnook.ics';

// One test per row of the mapping

test('UID → d: sha256 of the UID, or of UID and occurrence key', () => {
  assert.deepEqual(one(project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma').t, 'd'), ['d', nostrD('evt-PDzqdd9OU1nQXYz@events.lu.ma')]);
  const { t } = project('synthetic/recurring.ics', 'weekly@fixture.eventindex.space', { index: 1 });
  assert.deepEqual(one(t, 'd'), ['d', nostrD('weekly@fixture.eventindex.space', String(Date.UTC(2026, 9, 20, 17) / 1000))]);
});

test('SUMMARY → title, and a VEVENT without SUMMARY is skipped', () => {
  assert.deepEqual(one(project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma').t, 'title'), ['title', 'craftyween party']);
  const f = feed('synthetic/malformed.ics');
  const [o] = occurrencesOf(f, 'no-summary@fixture.eventindex.space');
  assert.deepEqual(projectOccurrence(o!, context(f)), { skip: 'no-summary' });
});

test('DTSTART → start and start_tzid', () => {
  const meetup = project('meetup-pythonsd.ics', 'event_312775793@meetup.com').t;
  assert.deepEqual(one(meetup, 'start'), ['start', String(Date.UTC(2026, 9, 23, 2) / 1000)]);
  assert.deepEqual(one(meetup, 'start_tzid'), ['start_tzid', 'America/Los_Angeles']);
  assert.equal(one(project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma').t, 'start_tzid'), undefined);
});

test('a floating DTSTART is read in the calendar zone and carries it', () => {
  const t = project('synthetic/floating.ics', 'floating-1@fixture.eventindex.space').t;
  assert.deepEqual(one(t, 'start'), ['start', String(Date.UTC(2026, 9, 21, 0) / 1000)]);
  assert.deepEqual(one(t, 'start_tzid'), ['start_tzid', 'America/Chicago']);
});

test('DTEND or DURATION → end, and end_tzid only when it differs', () => {
  const alias = project('synthetic/tzid-without-vtimezone.ics', 'tz-alias@fixture.eventindex.space').t;
  assert.deepEqual(one(alias, 'end'), ['end', String(Date.UTC(2026, 9, 22, 8) / 1000)]);
  assert.deepEqual(one(alias, 'end_tzid'), ['end_tzid', 'Europe/London']);
  const meetup = project('meetup-pythonsd.ics', 'event_312775793@meetup.com').t;
  assert.equal(one(meetup, 'end_tzid'), undefined);
  const duration = project('synthetic/floating-no-zone.ics', 'floating-2@fixture.eventindex.space').t;
  assert.deepEqual(one(duration, 'end'), ['end', String(Date.UTC(2026, 9, 20, 20, 30) / 1000)]);
});

test('an end that is not after the start → no end tag, and one D', () => {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:zero@x\r\nDTSTART:20261020T180000Z\r\nDTEND:20261020T180000Z\r\nSUMMARY:Zero length\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const t = project('synthetic/zero.ics', 'zero@x', { text }).t;
  assert.equal(one(t, 'end'), undefined);
  assert.deepEqual(all(t, 'D'), [['D', String(Math.floor(Date.UTC(2026, 9, 20, 18) / 86400000))]]);
});

test('no DTEND and no DURATION → no end tag', () => {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:open@x\r\nDTSTART:20261020T180000Z\r\nSUMMARY:Open end\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const t = project('synthetic/open-end.ics', 'open@x', { text }).t;
  assert.equal(one(t, 'end'), undefined);
  assert.deepEqual(all(t, 'D'), [['D', String(Math.floor(Date.UTC(2026, 9, 20, 18) / 86400000))]]);
});

test('every UTC day in [start, end) → D', () => {
  const twoDays = project(CRAFTNOOK, 'evt-BY6CUfvAuCM89l4@events.lu.ma').t;
  const day = (y: number, m: number, d: number) => String(Date.UTC(y, m - 1, d) / 86400000);
  assert.deepEqual(all(twoDays, 'D'), [['D', day(2026, 10, 16)], ['D', day(2026, 10, 17)]]);
  const toMidnight = project('synthetic/floating.ics', 'floating-1@fixture.eventindex.space').t;
  assert.deepEqual(all(toMidnight, 'D'), [['D', day(2026, 10, 21)]]);
});

test('DESCRIPTION → summary and content: the same text, at most 280 characters', () => {
  const { t, o } = project('meetup-pythonsd.ics', 'event_312775793@meetup.com');
  const expected = summarize(String(o.event.getFirstPropertyValue('description')));
  assert.deepEqual(one(t, 'summary'), ['summary', expected]);
  assert.equal(t.content, expected);
  assert.ok([...new Intl.Segmenter().segment(expected)].length <= 280);
  const long = project('synthetic/malformed.ics', 'long@fixture.eventindex.space').t;
  assert.ok([...new Intl.Segmenter().segment(long.content)].length <= 280);
});

test('a description with nothing but platform boilerplate gives no summary and empty content', () => {
  const t = project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma').t;
  assert.equal(one(t, 'summary'), undefined);
  assert.equal(t.content, '');
});

test('LOCATION and VLOCATION → one location tag per distinct value', () => {
  const rich = project('synthetic/rich.ics', 'rich@fixture.eventindex.space').t;
  assert.deepEqual(all(rich, 'location'), [['location', 'Library, Room 2'], ['location', 'Central Library']]);
  assert.deepEqual(all(project('mobilizon-lyontechhub.ics', 'ef6c676c-2ade-4e5a-85c9-9af55b530295').t, 'location'), []);
});

test('GEO → g at precision 9, and no place at all when the venue is hidden', () => {
  const open = project(LUMA_CITY, 'evt-8obJGsASb0HxSiX@events.lu.ma').t;
  assert.deepEqual(one(open, 'g'), ['g', encodeGeohash(40.6988592, -73.9747271, 9)]);
  const hidden = project(CRAFTNOOK, 'evt-BY6CUfvAuCM89l4@events.lu.ma').t;
  assert.equal(one(hidden, 'g'), undefined);
  assert.deepEqual(all(hidden, 'location'), []);
  assert.equal(one(project('meetup-pythonsd.ics', 'event_312775793@meetup.com').t, 'g'), undefined);
});

test('URL → r, else the calendar page; then the record', () => {
  const { t, o } = project(LUMA_CITY, 'evt-8obJGsASb0HxSiX@events.lu.ma');
  assert.deepEqual(all(t, 'r'), [['r', 'https://luma.com/pi1ww9st'], ['r', `https://api.eventindex.space/api/1.0/events/byid/${o.id}.ics`]]);
  const k8s = project('google-kubernetes-sig-cli.ics', '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com').t;
  assert.equal(all(k8s, 'r')[0]![1], 'https://calendar.google.com/calendar/embed?src=calendar%40kubernetes.io');
});

test('IMAGE, else an image ATTACH → image, where the source policy allows images', () => {
  assert.deepEqual(one(project('synthetic/rich.ics', 'rich@fixture.eventindex.space').t, 'image'), ['image', 'https://example.org/events/open-data-night.jpg']);
  const attached = readFixture('synthetic/rich.ics').replace('IMAGE;VALUE=URI;DISPLAY=FULLSIZE:https://example.org/events/open-data-night.jpg', 'ATTACH;FMTTYPE=image/jpeg:https://example.org/events/open-data-night.jpg');
  assert.deepEqual(one(project('synthetic/rich.ics', 'rich@fixture.eventindex.space', { text: attached }).t, 'image'), ['image', 'https://example.org/events/open-data-night.jpg']);
  // A calendar the index publishes as its organizer is verified: Mobilizon's image is served.
  const mobilizon = project('mobilizon-lyontechhub.ics', 'ef6c676c-2ade-4e5a-85c9-9af55b530295').t;
  assert.match(one(mobilizon, 'image')![1]!, /^https:\/\/mobilizon\.fr\/media\/a1689adf.*\.jpg/);
  const k8s = project('google-kubernetes-sig-cli.ics', '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com').t;
  assert.equal(one(k8s, 'image'), undefined, 'a document ATTACH is not an image');
  const withImage = readFixture(CRAFTNOOK).replace('UID:evt-PDzqdd9OU1nQXYz@events.lu.ma', 'UID:evt-PDzqdd9OU1nQXYz@events.lu.ma\nIMAGE;VALUE=URI:https://images.lumacdn.com/x.png');
  assert.equal(one(project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma', { text: withImage }).t, 'image'), undefined);
});

test('CATEGORIES → t, lowercased, each once', () => {
  const t = project('synthetic/rich.ics', 'rich@fixture.eventindex.space').t;
  assert.deepEqual(all(t, 't'), [['t', 'open data'], ['t', 'civic tech']]);
});

test('STATUS:CANCELLED → the same d, title prefixed "Cancelled: "', () => {
  const cancelled = project('synthetic/cancelled.ics', 'cancelled@fixture.eventindex.space').t;
  assert.deepEqual(one(cancelled, 'title'), ['title', 'Cancelled: Autumn social']);
  assert.deepEqual(one(cancelled, 'd'), ['d', nostrD('cancelled@fixture.eventindex.space')]);
  const override = project('synthetic/recurring.ics', 'weekly@fixture.eventindex.space', { index: 2 }).t;
  assert.deepEqual(one(override, 'title'), ['title', 'Cancelled: Weekly hack night']);
});

test('the projection hash changes with the projection, not with DTSTAMP or a shared SEQUENCE', () => {
  const base = readFixture(CRAFTNOOK);
  const hash = (text: string) => projectionHash(project(CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma', { text }).t);
  const original = hash(base);
  assert.equal(hash(base.replaceAll('DTSTAMP:20261015T180707Z', 'DTSTAMP:20261016T000000Z')), original);
  assert.equal(hash(base.replaceAll(/SEQUENCE:\d+/g, 'SEQUENCE:999')), original);
  assert.notEqual(hash(base.replace('SUMMARY:craftyween party', 'SUMMARY:craftyween party!')), original);
});

test('ORGANIZER and ATTENDEE never reach the projection', () => {
  const t = project('synthetic/rich.ics', 'rich@fixture.eventindex.space').t;
  const json = JSON.stringify(t);
  assert.ok(!json.includes('mailto:') && !json.includes('redacted@example.invalid') && !json.includes('Open Data Club'));
});

test('PARTICIPANT with a nostr key → p with its role; never an e-mail', () => {
  const t = project('synthetic/rich.ics', 'rich@fixture.eventindex.space').t;
  assert.deepEqual(all(t, 'p').filter((p) => p[1] === SPEAKER), [['p', SPEAKER, '', 'speaker']]);
  assert.equal(all(t, 'p').length, 2);
});

// Tags the indexer always adds

test('the indexer adds the events list, the host, the alt text and the client', () => {
  const { t } = project(LUMA_CITY, 'evt-8obJGsASb0HxSiX@events.lu.ma', { extra: { calendarName: 'Newlab Brooklyn' } });
  assert.deepEqual(one(t, 'z'), ['z', `39998:${INDEX}:events`]);
  assert.deepEqual(all(t, 'p')[0], ['p', CAL, RELAY, 'host']);
  assert.deepEqual(one(t, 'alt'), ['alt', 'Newlab Brooklyn: Drink & Draw, 2026-10-15']);
  assert.deepEqual(one(t, 'client'), ['client', 'eventindex']);
  assert.equal(t.kind, 31923);
});

test('the alt text gives the start date in the event\'s zone', () => {
  // 2026-10-23 02:00 UTC is 2026-10-22 in Los Angeles
  const t = project('meetup-pythonsd.ics', 'event_312775793@meetup.com').t;
  assert.deepEqual(one(t, 'alt'), ['alt', 'San Diego Python Users Group: SDPy Monthly Meetup, 2026-10-22']);
});

test('co-host calendars are extra host p tags', () => {
  const t = project(CRAFTNOOK, 'evt-ILpIInTRKRV1pnY@events.lu.ma', { extra: { cohosts: [COHOST] } }).t;
  assert.deepEqual(all(t, 'p'), [['p', CAL, RELAY, 'host'], ['p', COHOST, RELAY, 'host']]);
});

test('no projection carries an expiration tag', () => {
  for (const [fixture, uid] of [[CRAFTNOOK, 'evt-PDzqdd9OU1nQXYz@events.lu.ma'], ['synthetic/all-day.ics', 'allday-multi@fixture.eventindex.space']] as const) {
    assert.equal(one(project(fixture, uid).t, 'expiration'), undefined);
  }
});

test('an all-day event → 31922 with dates, and no D or zone tags', () => {
  const t = project('synthetic/all-day.ics', 'allday-multi@fixture.eventindex.space').t;
  assert.equal(t.kind, 31922);
  assert.deepEqual(one(t, 'start'), ['start', '2026-10-30']);
  assert.deepEqual(one(t, 'end'), ['end', '2026-11-02']);
  assert.deepEqual(all(t, 'D'), []);
  assert.equal(one(t, 'start_tzid'), undefined);
  const single = project('synthetic/all-day.ics', 'allday-single@fixture.eventindex.space').t;
  assert.equal(one(single, 'end'), undefined);
  assert.deepEqual(one(single, 'alt'), ['alt', 'All-Day Events: Single day with no end, 2026-10-24']);
});

test('D tags stop at 400 days, however long the event', () => {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:long@x\r\nDTSTART:20261020T100000Z\r\nDTEND:21261020T100000Z\r\nSUMMARY:Typo in the year\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const t = project('synthetic/long.ics', 'long@x', { text }).t;
  assert.equal(all(t, 'D').length, 400);
});
