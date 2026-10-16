// A native calendar's NIP-52 events as records: the bridge's other direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { nativeFeed, nativeUid } from '../src/native/record.ts';
import { occurrences, projectionWindow } from '../src/project/window.ts';
import { publicCalendar, toIcs, toJsonLd, publicContext } from '../src/project/public.ts';
import { decodeGeohash } from '../src/project/geohash.ts';
import { NOW } from './helpers.ts';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const ctx = { d: `nostr:${pubkey}`, source: 'nostr' as const, role: 'calendar' as const, feedUrl: '', pageUrl: 'https://example.org/', entryName: 'Lakeside Bitcoin Club' };
const RELAY = 'wss://relay.example.org';
const START = NOW + 5 * 86400;

function sign(kind: number, tags: string[][], content = '', at = NOW - 3600): VerifiedEvent {
  return finalizeEvent({ kind, tags, content, created_at: at }, sk);
}

const timed = (extra: string[][] = [], content = 'Monthly meetup. Bring a friend.') => sign(31923, [
  ['d', 'meetup-oct'], ['title', 'October meetup'], ['start', String(START)], ['end', String(START + 7200)],
  ['start_tzid', 'America/Chicago'], ['location', 'Lakeside Hall, 1 Main St'], ['g', 'dp3wjztvt'],
  ['r', 'https://example.org/events/oct'], ['image', 'https://example.org/oct.png'], ['t', 'Bitcoin'], ['t', 'meetup'], ...extra,
], content);

function only(events: VerifiedEvent[]) {
  const feed = nativeFeed(events.map((event) => ({ event, relay: RELAY })), { ...ctx, calendarName: 'Lakeside Bitcoin Club' });
  return { feed, vevent: feed.records[0]!.component.getFirstSubcomponent('vevent')! };
}

test('a time-based event becomes a record in its own zone', () => {
  const event = timed();
  const { feed, vevent } = only([event]);
  assert.equal(feed.records.length, 1);
  assert.equal(feed.records[0]!.uid, nativeUid(event));
  assert.equal(nativeUid(event), `31923:${pubkey}:meetup-oct`);
  assert.equal(vevent.getFirstPropertyValue('summary'), 'October meetup');
  const start = vevent.getFirstProperty('dtstart')!;
  assert.equal(start.getParameter('tzid'), 'America/Chicago');
  assert.equal((start.getFirstValue() as ICAL.Time).toUnixTime(), START);
  assert.equal((vevent.getFirstPropertyValue('dtend') as ICAL.Time).toUnixTime(), START + 7200);
  assert.equal(vevent.getFirstPropertyValue('description'), 'Monthly meetup. Bring a friend.');
  assert.equal(vevent.getFirstPropertyValue('location'), 'Lakeside Hall, 1 Main St');
  assert.equal(vevent.getFirstPropertyValue('url'), 'https://example.org/events/oct');
  assert.equal(vevent.getFirstPropertyValue('image'), 'https://example.org/oct.png');
  assert.deepEqual(vevent.getFirstProperty('categories')!.getValues(), ['bitcoin', 'meetup']);
  const [lat, lon] = vevent.getFirstPropertyValue('geo') as [number, number];
  const [clat, clon] = decodeGeohash('dp3wjztvt')!;
  assert.ok(Math.abs(lat - clat) < 1e-6 && Math.abs(lon - clon) < 1e-6);
  assert.equal((vevent.getFirstPropertyValue('last-modified') as ICAL.Time).toUnixTime(), event.created_at);
  assert.equal(vevent.getFirstPropertyValue('x-eventindex-source'), 'nostr');
  assert.equal(feed.calendar.name, 'Lakeside Bitcoin Club');
});

test('the record names the event it came from by address', () => {
  const { vevent } = only([timed()]);
  const naddr = String(vevent.getFirstPropertyValue('x-eventindex-nostr'));
  const decoded = decode(naddr);
  assert.equal(decoded.type, 'naddr');
  assert.deepEqual(decoded.data, { kind: 31923, pubkey, identifier: 'meetup-oct', relays: [RELAY] });
});

test('a date-based event becomes an all-day record with an exclusive end', () => {
  const { vevent } = only([sign(31922, [['d', 'fest'], ['title', 'Harvest festival'], ['start', '2026-10-24'], ['end', '2026-10-26']])]);
  const start = vevent.getFirstPropertyValue('dtstart') as ICAL.Time;
  assert.ok(start.isDate);
  assert.equal(start.toString(), '2026-10-24');
  assert.equal((vevent.getFirstPropertyValue('dtend') as ICAL.Time).toString(), '2026-10-26');
});

test('a time without a known zone is written in UTC, and an end not after the start is dropped', () => {
  const { vevent } = only([sign(31923, [['d', 'x'], ['title', 'Call'], ['start', String(START)], ['end', String(START)], ['start_tzid', 'Mars/Olympus']])]);
  const start = vevent.getFirstProperty('dtstart')!;
  assert.equal(start.getParameter('tzid'), undefined);
  assert.equal((start.getFirstValue() as ICAL.Time).zone?.tzid, 'UTC');
  assert.ok(!vevent.hasProperty('dtend'));
});

test('extra places become VLOCATIONs, and the summary tag stands in for empty content', () => {
  const { vevent } = only([sign(31923, [['d', 'y'], ['title', 'Hybrid talk'], ['start', String(START)], ['summary', 'A talk, in the room and online.'],
    ['location', 'Room 4'], ['location', 'https://meet.example.org/talk'], ['location', 'Room 4']])]);
  assert.equal(vevent.getFirstPropertyValue('location'), 'Room 4');
  assert.deepEqual(vevent.getAllSubcomponents('vlocation').map((v) => v.getFirstPropertyValue('name')), ['https://meet.example.org/talk']);
  assert.equal(vevent.getFirstPropertyValue('description'), 'A talk, in the room and online.');
});

test('a cancelled event is marked cancelled, its title without the prefix', () => {
  const prefixed = only([sign(31923, [['d', 'c1'], ['title', 'Cancelled: Picnic'], ['start', String(START)]])]).vevent;
  assert.equal(prefixed.getFirstPropertyValue('summary'), 'Picnic');
  assert.equal(prefixed.getFirstPropertyValue('status'), 'CANCELLED');
  const tagged = only([sign(31923, [['d', 'c2'], ['title', 'Picnic'], ['start', String(START)], ['status', 'cancelled']])]).vevent;
  assert.equal(tagged.getFirstPropertyValue('status'), 'CANCELLED');
});

test('the deprecated name tag stands in for a missing title; events without a title, d or start are left out', () => {
  const feed = nativeFeed([
    sign(31923, [['d', 'a'], ['name', 'Old-style title'], ['start', String(START)]]),
    sign(31923, [['d', 'b'], ['start', String(START)]]),
    sign(31923, [['title', 'No d'], ['start', String(START)]]),
    sign(31923, [['d', 'c'], ['title', 'Bad start'], ['start', 'soon']]),
    sign(31922, [['d', 'e'], ['title', 'Bad date'], ['start', '2026-13-40']]),
  ].map((event) => ({ event, relay: RELAY })), { ...ctx, calendarName: 'Lakeside Bitcoin Club' });
  assert.deepEqual(feed.records.map((r) => r.uid), [`31923:${pubkey}:a`]);
  assert.deepEqual(feed.log.map((l) => l.code).sort(), ['bad-value', 'bad-value', 'no-title', 'no-uid']);
});

test('the record is served through the public projections with its full description and image', () => {
  const { feed } = only([timed([], 'A long description. '.repeat(30).trim())]);
  const record = feed.records[0]!;
  const [o] = occurrences(record, projectionWindow(NOW), { calendarD: ctx.d }).items;
  assert.ok(o);
  const text = toIcs(publicCalendar(record, o, publicContext(feed, NOW)));
  assert.ok(text.includes('IMAGE'));
  const ld = toJsonLd(o, publicContext(feed, NOW));
  assert.equal(ld['name'], 'October meetup');
  assert.equal(ld['image'], 'https://example.org/oct.png');
  assert.ok(String(ld['description']).length <= 300);
  assert.equal((ld['organizer'] as Record<string, unknown>)['name'], 'Lakeside Bitcoin Club');
});
