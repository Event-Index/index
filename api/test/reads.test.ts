import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import ICAL from 'ical.js';
import { npubEncode } from 'nostr-tools/nip19';
import { harness, type Harness } from './harness.ts';
import { NOW } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const API = '/api/1.0';
const graphemes = (text: string) => [...new Intl.Segmenter().segment(text)].length;
const veventsOf = (ics: string) => new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent');
const local = (d: string) => h.dir.get(d)!.localName;

async function json(path: string): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await h.get(path);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('a calendar by its local name: the directory entry and the index\'s facts about it', async () => {
  const name = local('meetup:pythonsd');
  const { status, headers, body } = await json(`${API}/calendars/byslug/${name}`);
  assert.equal(status, 200);
  assert.equal(headers.get('access-control-allow-origin'), '*');
  assert.match(headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(body.calendar, {
    d: 'meetup:pythonsd', name: 'San Diego Python Users Group', role: 'calendar', source: 'meetup',
    feed: 'https://www.meetup.com/pythonsd/events/ical/', url: 'https://www.meetup.com/pythonsd/',
    description: h.dir.get('meetup:pythonsd')!.description, image: null, location: 'San Diego, US', g: '9mud', t: [],
  });
  assert.equal(body.eventindex.local_name, name);
  assert.equal(body.eventindex.address, `39999:${h.indexPubkey}:meetup:pythonsd`);
  assert.equal(body.eventindex.nostr, null, 'a mirrored calendar has no key of its own');
  assert.equal(body.eventindex.page, `https://eventindex.space/calendar/${name}`);
  assert.equal(body.eventindex.ics, `https://api.eventindex.space/api/1.0/ics/calendar/${name}.ics`);
  assert.equal(body.eventindex.last_indexed, NOW);
  assert.equal(body.eventindex.event_count, 4);
  assert.equal(body.eventindex.stale, false);
  assert.equal(body.eventindex.claimed, false);
  assert.equal(body.eventindex.removed, false);
});

test('a calendar by its feed URL (any spelling of it) and by its organizer\'s key', async () => {
  for (const url of ['https://www.meetup.com/pythonsd/events/ical/', 'webcal://www.meetup.com/pythonsd/events/ical/', 'https://meetup.com/pythonsd/events/ical']) {
    const { status, body } = await json(`${API}/calendars/byfeedurl?url=${encodeURIComponent(url)}`);
    assert.equal(status, 200, url);
    assert.equal(body.calendar.d, 'meetup:pythonsd');
  }
  const organizer = 'a0'.repeat(32);
  h.dir.setOwnership('meetup:pythonsd', { mode: 'mirrored', owner: organizer, claimedAt: 1, nativeCalendar: null });
  try {
    assert.equal((await json(`${API}/calendars/byguid/${npubEncode(organizer)}`)).body.calendar.d, 'meetup:pythonsd');
  } finally {
    h.dir.setOwnership('meetup:pythonsd', { mode: 'mirrored', owner: null, claimedAt: null, nativeCalendar: null });
  }
  const missing = await json(`${API}/calendars/byslug/no-such-calendar`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not-found');
  assert.equal((await json(`${API}/calendars/byfeedurl`)).status, 400);
});

test('calendar search by term and by area', async () => {
  const byTerm = await json(`${API}/search/calendars/byterm?q=python`);
  assert.equal(byTerm.status, 200);
  assert.deepEqual(byTerm.body.calendars.map((c: any) => c.calendar.d), ['meetup:pythonsd']);
  assert.equal(byTerm.body.count, 1);
  const near = await json(`${API}/search/calendars/byterm?near=dr5ru`);
  assert.deepEqual(near.body.calendars.map((c: any) => c.calendar.d).sort(), ['luma:cal-BvuRd9eaZnDGBwy', 'luma:cal-f6iLyfD3TN5qUO2']);
  assert.equal((await json(`${API}/search/calendars/byterm?near=not!a*geohash`)).status, 400);
});

test('a calendar\'s events: jCal items with the index\'s facts, and the feed as Link rel="via"', async () => {
  const response = await h.get(`${API}/events/bycalendar/${local('meetup:pythonsd')}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('link'), '<https://www.meetup.com/pythonsd/events/ical/>; rel="via"');
  const body = await response.json() as any;
  assert.equal(body.count, 4);
  const first = body.events[0];
  assert.equal(first.jcal[0], 'vcalendar');
  const vevent = new ICAL.Component(first.jcal).getFirstSubcomponent('vevent')!;
  assert.equal(String(vevent.getFirstPropertyValue('x-eventindex-id')), first.eventindex.id);
  assert.equal(first.eventindex.calendar, 'meetup:pythonsd');
  assert.equal(first.eventindex.source, 'meetup');
  assert.match(first.eventindex.nostr, /^naddr1/);
  assert.equal(first.eventindex.canonical, null);
  assert.deepEqual(first.eventindex.cohosts, []);
  assert.equal(first.eventindex.url, `https://api.eventindex.space/api/1.0/events/byid/${first.eventindex.id}`);
  const starts = body.events.map((e: any) => e.eventindex.start);
  assert.deepEqual(starts, [...starts].sort((a: number, b: number) => a - b));
  const window = await json(`${API}/events/bycalendar/${local('meetup:pythonsd')}?from=${NOW}&to=${NOW + 7 * 86400}`);
  assert.equal(window.body.count, 1);
  const ld = await json(`${API}/events/bycalendar/${local('meetup:pythonsd')}.json`);
  assert.equal(ld.body.events[0]['@type'], 'Event');
});

test('one event as .ics, jCal and JSON-LD; a reserved source gets the summary only and no images', async () => {
  const id = h.events.byCalendar('meetup:pythonsd', NOW - 86400 * 30, NOW + 86400 * 365).find((e) => e.uid === 'event_312775793@meetup.com')!.id;
  const ics = await h.get(`${API}/events/byid/${id}.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type')!, /^text\/calendar/);
  assert.equal(ics.headers.get('link'), '<https://www.meetup.com/pythonsd/events/ical/>; rel="via"');
  const text = await ics.text();
  assert.ok(!/^(ORGANIZER|ATTENDEE|STYLED-DESCRIPTION|IMAGE)/m.test(text));
  const [vevent] = veventsOf(text);
  assert.ok(graphemes(String(vevent!.getFirstPropertyValue('description'))) <= 280);
  const jcal = await h.get(`${API}/events/byid/${id}`);
  assert.match(jcal.headers.get('content-type')!, /^application\/calendar\+json/);
  assert.equal(((await jcal.json()) as any)[0], 'vcalendar');
  const ld = await h.get(`${API}/events/byid/${id}.json`);
  assert.match(ld.headers.get('content-type')!, /^application\/ld\+json/);
  const event = await ld.json() as any;
  assert.equal(event['@type'], 'Event');
  assert.equal(event.url, 'https://www.meetup.com/pythonsd/events/312775793/');
  assert.equal(event.image, undefined);
  assert.ok(graphemes(event.description) <= 280);
  assert.equal((await h.get(`${API}/events/byid/${'a'.repeat(32)}`)).status, 404);
  assert.equal((await h.get(`${API}/events/byid/not-an-id`)).status, 404);
});

test('an open source keeps its full description and images', async () => {
  const row = h.events.byCalendar('mobilizon:mobilizon.fr/@lyontechhub', 0, NOW * 2).find((e) => e.uid === 'c93acabc-0885-40ca-b861-565079746ed2')!;
  const event = await (await h.get(`${API}/events/byid/${row.id}.json`)).json() as any;
  assert.match(event.image, /^https:\/\//);
  const text = await (await h.get(`${API}/events/byid/${row.id}.ics`)).text();
  assert.match(text, /^STYLED-DESCRIPTION/m);
});

test('a hidden venue has no place in any format, and is found near its calendar\'s area', async () => {
  const id = 'qrippy6usrk5uthpkimlg63ybc7alyzo';
  const text = await (await h.get(`${API}/events/byid/${id}.ics`)).text();
  assert.ok(!/^(LOCATION|GEO)/m.test(text));
  assert.match(text, /^X-EVENTINDEX-VENUE:hidden/m);
  const ld = await (await h.get(`${API}/events/byid/${id}.json`)).json() as any;
  assert.equal(ld.location, undefined);
  const near = await json(`${API}/search/events/byterm?near=dr5r&from=${NOW}&to=${NOW + 7 * 86400}`);
  assert.ok(near.body.events.some((e: any) => e.eventindex.id === id));
  const far = await json(`${API}/search/events/byterm?near=9mud&from=${NOW}&to=${NOW + 7 * 86400}`);
  assert.ok(!far.body.events.some((e: any) => e.eventindex.id === id));
});

test('a co-hosted event: one projection, the copy points at it', async () => {
  const rows = [...h.events.byCalendar('luma:cal-BvuRd9eaZnDGBwy', 0, NOW * 2), ...h.events.byCalendar('luma:cal-f6iLyfD3TN5qUO2', 0, NOW * 2)]
    .filter((e) => e.uid === 'evt-ILpIInTRKRV1pnY@events.lu.ma');
  assert.equal(rows.length, 2);
  const items = await Promise.all(rows.map(async (r) => {
    const body = (await json(`${API}/events/bycalendar/${local(r.calendarD)}`)).body;
    return body.events.find((e: any) => e.eventindex.id === r.id).eventindex;
  }));
  const copy = items.find((i) => i.canonical)!;
  const signer = items.find((i) => !i.canonical)!;
  assert.equal(copy.canonical, signer.id);
  assert.equal(copy.nostr, signer.nostr);
  assert.deepEqual(signer.cohosts, [copy.calendar]);
});

test('a recurring record and one occurrence of it', async () => {
  const rows = h.events.byCalendar('google:calendar@kubernetes.io', 0, NOW * 2);
  const series = rows.filter((r) => r.uid === rows[0]!.uid);
  assert.ok(series.length > 1);
  const occurrence = veventsOf(await (await h.get(`${API}/events/byid/${series[1]!.id}.ics`)).text());
  assert.equal(occurrence.length, 1);
  assert.ok(occurrence[0]!.hasProperty('recurrence-id'));
  assert.ok(!occurrence[0]!.hasProperty('rrule'));
  const record = veventsOf(await (await h.get(`${API}/events/byid/${series[1]!.recordId}.ics`)).text());
  assert.ok(record.some((v) => v.hasProperty('rrule')));
  const ld = await (await h.get(`${API}/events/byid/${series[1]!.recordId}.json`)).json() as any;
  assert.equal(ld['@type'], 'EventSeries');
  assert.ok(ld.subEvent.length > 1);
});

test('event search by term, time and tag', async () => {
  const all = await json(`${API}/search/events/byterm?from=${NOW}&to=${NOW + 365 * 86400}`);
  assert.ok(all.body.count > 10);
  const python = await json(`${API}/search/events/byterm?q=python&from=${NOW - 30 * 86400}&to=${NOW + 365 * 86400}`);
  assert.ok(python.body.count >= 1);
  assert.ok(python.body.events.every((e: any) => e.eventindex.source));
  assert.equal((await json(`${API}/search/events/byterm?from=abc`)).status, 400);
  assert.equal((await json(`${API}/search/events/byterm?radius=5`)).status, 400, 'a radius needs near');
});

test('a calendar\'s events as one .ics feed, and a city\'s', async () => {
  const response = await h.get(`${API}/ics/calendar/${local('meetup:pythonsd')}.ics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/calendar/);
  const calendar = new ICAL.Component(ICAL.parse(await response.text()));
  assert.equal(calendar.getFirstPropertyValue('name'), 'San Diego Python Users Group');
  assert.equal(calendar.getAllSubcomponents('vevent').length, 4);
  assert.ok(calendar.getAllSubcomponents('vtimezone').length >= 1);
  const city = new ICAL.Component(ICAL.parse(await (await h.get(`${API}/ics/city/new-york.ics`)).text()));
  const uids = city.getAllSubcomponents('vevent').map((v) => String(v.getFirstPropertyValue('uid')));
  assert.equal(uids.filter((u) => u === 'evt-ILpIInTRKRV1pnY@events.lu.ma').length, 1, 'a co-hosted event once');
  assert.equal((await h.get(`${API}/ics/city/atlantis.ics`)).status, 404);
});

test('stats, and the nightly dump without any event content', async () => {
  const stats = await json(`${API}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.calendars, 5);
  assert.equal(stats.body.aggregators, 0);
  assert.ok(stats.body.events.upcoming > 0);
  assert.equal(stats.body.polls.ok_last_24h, 5);
  assert.equal(stats.body.polls.stale, 0);
  assert.equal(stats.body.dump.generated_at, NOW);
  const dump = await h.get(`${API}/dump/index.db`);
  assert.equal(dump.status, 200);
  assert.equal(dump.headers.get('content-type'), 'application/vnd.sqlite3');
  const bytes = Buffer.from(await dump.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  const file = join(h.dataDir, 'fetched.db');
  writeFileSync(file, bytes);
  const copy = new Database(file, { readonly: true });
  const tables = copy.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  copy.close();
  assert.deepEqual(tables, ['about', 'calendars', 'poll_stats']);
});

test('NIP-05 names only the index key, as _', async () => {
  const name = local('meetup:pythonsd');
  const response = await h.get(`/.well-known/nostr.json?name=${name}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), { names: {} }, 'no calendar has a name of its own');
  assert.deepEqual((await json('/.well-known/nostr.json?name=_')).body, { names: { _: h.indexPubkey }, relays: { [h.indexPubkey]: ['wss://relay.eventindex.space'] } });
  assert.deepEqual((await json('/.well-known/nostr.json?name=nobody')).body, { names: {} });
  assert.deepEqual((await json('/.well-known/nostr.json')).body.names, { _: h.indexPubkey });
});

test('unknown paths and methods', async () => {
  const missing = await json(`${API}/nothing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not-found');
  const method = await fetch(`${h.base}${API}/stats`, { method: 'DELETE' });
  assert.equal(method.status, 405);
  const preflight = await fetch(`${h.base}${API}/feeds/add`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods')!, /POST/);
});
