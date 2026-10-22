import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIndexDb } from '../src/store/index-db.ts';
import { directoryStore, type Entry } from '../src/store/directory.ts';
import { discoveredStore } from '../src/store/discovered.ts';
import { lumaCityPage, lumaListedCalendars } from '../src/directory/discover.ts';
import { directoryEntry } from '../src/directory/entry.ts';
import { createDiscovery, areaOf, DISCOVERY_INTERVAL, type DiscoverySettings } from '../src/service/discovery.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { NOW } from './helpers.ts';

const H = 3600;
const DAY = 86400;
const PLACE = { api_id: 'discplace-TestPlace0001', name: 'Testville', slug: 'testville' };
const PAGE_URL = 'https://luma.com/testville';

interface PageEvent {
  cal: string;
  name?: string;
  personal?: boolean;
  owner?: boolean;
  access?: string;
  event?: string;
  hosts?: string[];
}

// A Luma city page as it carries its data, cut to what discovery reads.
function cityPage(events: PageEvent[], place = PLACE): string {
  const data = {
    props: {
      pageProps: {
        initialData: {
          kind: 'discover-place',
          data: {
            place,
            events: events.map((e, i) => ({
              api_id: `evt-Test${String(i).padStart(10, '0')}`,
              event: { api_id: `evt-Test${String(i).padStart(10, '0')}`, name: e.event ?? `Event ${i}`, url: `ev${i}`, start_at: '2026-10-20T23:00:00.000Z' },
              calendar: {
                api_id: e.cal, name: e.name ?? `Calendar ${e.cal}`, slug: null, access_level: e.access ?? 'public',
                is_personal: e.personal ?? false, personal_user_api_id: e.owner ? 'usr-TestUser0001' : null,
              },
              hosts: (e.hosts ?? []).map((name) => ({ name })),
            })),
          },
        },
      },
    },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function calendarFeed(name: string, events = 1): string {
  const vevents = Array.from({ length: events }, (_, i) => [
    'BEGIN:VEVENT', `UID:evt-feed${i}@events.lu.ma`, 'DTSTAMP:20261015T000000Z', `DTSTART:202610${20 + i}T230000Z`, `DTEND:202610${20 + i}T235900Z`,
    `SUMMARY:Meetup ${i}`, 'END:VEVENT',
  ].join('\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Luma//Test//EN', `X-WR-CALNAME:${name}`, ...vevents, 'END:VCALENDAR'].join('\n');
}

const calendarUrl = (id: string) => `https://api.luma.com/ics/get?entity=calendar&id=${id}`;

function aggregator(extra: Partial<Entry> = {}): Entry {
  return {
    d: `luma:${PLACE.api_id}`, role: 'aggregator', source: 'luma', feedUrl: `https://api.luma.com/ics/get?entity=discover&id=${PLACE.api_id}`,
    pageUrl: PAGE_URL, name: null, description: null, image: null, location: 'Testville, US', g: '9mud', foundVia: 'luma:discover', addedAt: NOW - DAY, ...extra,
  };
}

function setup(options: { pages?: Record<string, string>; feeds?: Record<string, string>; settings?: Partial<DiscoverySettings>; listed?: Array<{ slug: string; url: string }>; noAggregator?: boolean } = {}) {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const found = discoveredStore(db);
  const log: string[] = [];
  const fetched: string[] = [];
  const answers: Record<string, string> = { ...options.pages, ...options.feeds };
  const discovery = createDiscovery({
    dir,
    found,
    log: (line) => log.push(line),
    fetch: async (url): Promise<FetchResult> => {
      fetched.push(url);
      const text = answers[url];
      return text === undefined ? { status: 'error', code: 'http-404' } : { status: 'ok', text, etag: null, lastModified: null, finalUrl: url };
    },
    settings: { perRun: 25, perDay: 300, checksPerStep: 5, ...options.settings },
    ...(options.listed ? { listedPages: options.listed } : {}),
  });
  if (!options.noAggregator) dir.add(aggregator());
  return { db, dir, found, log, fetched, discovery, answers };
}

// Runs steps until nothing is left to check, at most `max`.
async function drain(discovery: ReturnType<typeof createDiscovery>, now: number, max = 20): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const r = await discovery.step(now);
    if (!r.page && r.checked.length === 0) return;
  }
}

test('a Luma city page names its place and, for each event shown, the event\'s calendar', () => {
  const page = lumaCityPage(cityPage([
    { cal: 'cal-Named0000000001', name: 'Design Meetup', event: 'Interfaces night', hosts: ['Design Meetup'] },
    { cal: 'cal-Personal000001', name: 'Personal', personal: true, owner: true, hosts: ['A Host'] },
    { cal: 'cal-Owned000000001', name: 'My things', owner: true },
    { cal: 'cal-Members0000001', name: 'Members only', access: 'private' },
  ]));
  assert.deepEqual(page.place, { id: PLACE.api_id, slug: 'testville', name: 'Testville' });
  assert.equal(page.events.length, 4);
  assert.deepEqual(page.events[0], {
    calendar: { id: 'cal-Named0000000001', name: 'Design Meetup', slug: null, personal: false, access: 'public' },
    name: 'Interfaces night', url: 'https://luma.com/ev0', start: '2026-10-20T23:00:00.000Z', hosts: ['Design Meetup'],
  });
  assert.equal(page.events[1]!.calendar.personal, true);
  // An account's own calendar is personal whatever it is called.
  assert.equal(page.events[2]!.calendar.personal, true);
  assert.equal(page.events[3]!.calendar.access, 'private');
  assert.deepEqual(lumaCityPage('<html>no data</html>'), { place: null, events: [] });
});

test('discovery files a named public calendar of an event on the page under the page\'s area, for the next poll', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-Named0000000001', name: 'Design Meetup' }]) },
    feeds: { [calendarUrl('cal-Named0000000001')]: calendarFeed('Design Meetup', 2) },
  });
  await drain(s.discovery, NOW);
  const filed = s.dir.get('luma:cal-Named0000000001')!;
  assert.equal(filed.role, 'calendar');
  assert.equal(filed.name, 'Design Meetup');
  assert.equal(filed.location, 'Testville, US');
  assert.equal(filed.g, '9mud');
  assert.equal(filed.foundVia, `luma:${PLACE.api_id}`);
  assert.equal(filed.addedAt, NOW);
  assert.equal(s.db.pollState(filed.d).nextPollAt, 0);
  assert.equal(s.found.get('luma:cal-Named0000000001')!.status, 'filed');
  assert.ok(s.log.some((l) => l.includes('filed luma:cal-Named0000000001 "Design Meetup"')), s.log.join('\n'));
  assert.ok(s.log.some((l) => /discovery Testville .*1 event, 1 calendar: 1 new to check/.test(l)), s.log.join('\n'));
});

test('discovery skips a platform default and a calendar that is not public, records each skip once, and never fetches their feeds', async () => {
  const s = setup({
    pages: {
      [PAGE_URL]: cityPage([
        { cal: 'cal-Personal000001', name: 'Personal', personal: true, owner: true, event: 'Print exchange', hosts: ['A Host', 'B Host'] },
        { cal: 'cal-Members0000001', name: 'Members only', access: 'private' },
      ]),
    },
  });
  await drain(s.discovery, NOW);
  const personal = s.found.get('luma:cal-Personal000001')!;
  assert.equal(personal.status, 'skipped');
  assert.equal(personal.reason, 'platform-default-calendar');
  assert.deepEqual(personal.detail, { event: 'Print exchange', url: 'https://luma.com/ev0', hosts: ['A Host', 'B Host'] });
  assert.equal(s.found.get('luma:cal-Members0000001')!.reason, 'not-public');
  assert.deepEqual(s.fetched, [PAGE_URL]);
  assert.equal(s.dir.get('luma:cal-Personal000001'), null);
  assert.equal(s.log.filter((l) => l.includes('skipped luma:cal-Personal000001')).length, 1);

  // Seen again at the next run: counted, not logged or recorded again.
  await drain(s.discovery, NOW + DISCOVERY_INTERVAL);
  assert.equal(s.log.filter((l) => l.includes('skipped luma:cal-Personal000001')).length, 1);
  assert.equal(s.found.get('luma:cal-Personal000001')!.lastAt, NOW + DISCOVERY_INTERVAL);
  assert.equal(s.found.get('luma:cal-Personal000001')!.firstAt, NOW);
});

test('a calendar whose feed turns out to be a platform default, or has no events, is not filed; an empty one is tried again a day later', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-Default0000001', name: 'Weekly' }, { cal: 'cal-Empty00000001', name: 'Quiet' }]) },
    feeds: { [calendarUrl('cal-Default0000001')]: calendarFeed('Personal'), [calendarUrl('cal-Empty00000001')]: calendarFeed('Quiet', 0) },
  });
  await drain(s.discovery, NOW);
  assert.equal(s.dir.get('luma:cal-Default0000001'), null);
  assert.equal(s.found.get('luma:cal-Default0000001')!.status, 'skipped');
  assert.equal(s.found.get('luma:cal-Default0000001')!.reason, 'platform-default-calendar');
  assert.equal(s.found.get('luma:cal-Empty00000001')!.status, 'refused');
  assert.equal(s.found.get('luma:cal-Empty00000001')!.reason, 'no-events');

  // Six hours on, the page is read again but the empty calendar waits.
  s.fetched.length = 0;
  await drain(s.discovery, NOW + DISCOVERY_INTERVAL);
  assert.deepEqual(s.fetched, [PAGE_URL]);

  // A day on, it has an event and is filed.
  s.answers[calendarUrl('cal-Empty00000001')] = calendarFeed('Quiet', 1);
  await drain(s.discovery, NOW + 4 * DISCOVERY_INTERVAL);
  assert.equal(s.dir.get('luma:cal-Empty00000001')!.name, 'Quiet');
  assert.equal(s.found.get('luma:cal-Empty00000001')!.status, 'filed');
});

test('a calendar already in the directory, or kept out of it, is left alone', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-Listed00000001' }, { cal: 'cal-Blocked0000001' }]) },
  });
  s.dir.add({ ...aggregator(), d: 'luma:cal-Listed00000001', role: 'calendar', feedUrl: calendarUrl('cal-Listed00000001'), pageUrl: null, foundVia: 'maintainer' });
  s.dir.block('luma:cal-Blocked0000001', 'organizer request', NOW - DAY);
  await drain(s.discovery, NOW);
  assert.deepEqual(s.fetched, [PAGE_URL]);
  assert.equal(s.found.get('luma:cal-Listed00000001'), null);
  assert.equal(s.dir.get('luma:cal-Blocked0000001'), null);
  assert.ok(s.log.some((l) => l.includes('2 already listed or kept out')), s.log.join('\n'));
});

test('one run takes at most the cap of new calendars from a page; the rest wait for its next run', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `cal-Capped000000${i}`);
  const s = setup({
    pages: { [PAGE_URL]: cityPage(ids.map((cal) => ({ cal }))) },
    feeds: Object.fromEntries(ids.map((id) => [calendarUrl(id), calendarFeed(id)])),
    settings: { perRun: 3 },
  });
  await drain(s.discovery, NOW);
  assert.equal(s.dir.list().filter((e) => e.role === 'calendar').length, 3);
  assert.ok(s.log.some((l) => l.includes('5 over the cap of 3 a run')), s.log.join('\n'));
  await drain(s.discovery, NOW + DISCOVERY_INTERVAL);
  assert.equal(s.dir.list().filter((e) => e.role === 'calendar').length, 6);
});

test('discovery files no more than the cap a day', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `cal-Daily0000000${i}`);
  const feeds = Object.fromEntries(ids.map((id) => [calendarUrl(id), calendarFeed(id)]));
  const daily = setup({ pages: { [PAGE_URL]: cityPage(ids.map((cal) => ({ cal }))) }, feeds, settings: { perDay: 4 } });
  await drain(daily.discovery, NOW);
  assert.equal(daily.dir.list().filter((e) => e.role === 'calendar').length, 4);
  assert.equal(daily.found.get(`luma:${ids[5]}`)!.status, 'candidate');
  assert.equal(daily.log.filter((l) => l.includes('the cap of 4 a day')).length, 1);
  await drain(daily.discovery, NOW + DAY + 1);
  assert.equal(daily.dir.list().filter((e) => e.role === 'calendar').length, 6);
});

test('one page is read per step, each every six hours; a page that fails is tried again in an hour', async () => {
  const other = { api_id: 'discplace-TestPlace0002', name: 'Otherton', slug: 'otherton' };
  const s = setup({ pages: { [PAGE_URL]: cityPage([]) } });
  s.dir.add(aggregator({ d: `luma:${other.api_id}`, feedUrl: `https://api.luma.com/ics/get?entity=discover&id=${other.api_id}`, pageUrl: 'https://luma.com/broken' }));
  const first = await s.discovery.step(NOW);
  const second = await s.discovery.step(NOW);
  assert.ok(first.page && second.page && first.page.place !== second.page.place);
  assert.equal((await s.discovery.step(NOW)).page, null);
  assert.ok(s.log.some((l) => l.includes('page https://luma.com/broken: http-404')), s.log.join('\n'));
  assert.equal((await s.discovery.step(NOW + H)).page?.place, `luma:${other.api_id}`);
  assert.equal((await s.discovery.step(NOW + H)).page, null);
  const later = [await s.discovery.step(NOW + DISCOVERY_INTERVAL), await s.discovery.step(NOW + DISCOVERY_INTERVAL)];
  assert.deepEqual(later.map((r) => r.page?.place).sort(), [`luma:${PLACE.api_id}`, `luma:${other.api_id}`]);
});

test('a page that shows another place than its aggregator\'s is not read for calendars', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-Elsewhere00001' }], { api_id: 'discplace-Elsewhere001', name: 'Elsewhere', slug: 'elsewhere' }) },
    feeds: { [calendarUrl('cal-Elsewhere00001')]: calendarFeed('Elsewhere') },
  });
  await drain(s.discovery, NOW);
  assert.equal(s.found.get('luma:cal-Elsewhere00001'), null);
  assert.ok(s.log.some((l) => l.includes('shows discplace-Elsewhere001, not discplace-TestPlace0001')), s.log.join('\n'));
});

test('a step checks at most a few waiting calendars, so a tick stays short', async () => {
  const ids = Array.from({ length: 7 }, (_, i) => `cal-Paced0000000${i}`);
  const s = setup({
    pages: { [PAGE_URL]: cityPage(ids.map((cal) => ({ cal }))) },
    feeds: Object.fromEntries(ids.map((id) => [calendarUrl(id), calendarFeed(id)])),
    settings: { checksPerStep: 3 },
  });
  const first = await s.discovery.step(NOW);
  assert.equal(first.checked.length, 3);
  assert.equal((await s.discovery.step(NOW)).checked.length, 3);
  assert.equal((await s.discovery.step(NOW)).checked.length, 1);
});

test('the discovered store lists what discovery did since a time, for the maintainer', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-Named0000000001', name: 'Design Meetup' }, { cal: 'cal-Personal000001', name: 'Personal', personal: true }]) },
    feeds: { [calendarUrl('cal-Named0000000001')]: calendarFeed('Design Meetup') },
  });
  await drain(s.discovery, NOW);
  const since = s.found.since(NOW - H);
  assert.deepEqual(since.map((f) => [f.d, f.status]).sort(), [['luma:cal-Named0000000001', 'filed'], ['luma:cal-Personal000001', 'skipped']]);
  assert.deepEqual(s.found.since(NOW + 1), []);
});

test('an aggregator\'s directory entry names its page\'s place but no calendar to link to, and no key', () => {
  const entry = directoryEntry({
    identity: { d: `luma:${PLACE.api_id}`, role: 'aggregator', source: 'luma', feedUrl: aggregator().feedUrl, pageUrl: PAGE_URL },
    calendar: { name: 'What is happening in Testville', nameSource: 'X-WR-CALNAME', platformDefault: false, description: null, url: null, image: null, color: null, refreshInterval: null, timezone: null },
    header: `39998:${'ab'.repeat(32)}:event-calendars`, pubkey: null, localName: 'luma-discplace-testplace0001', location: 'Testville, US', geohash: '9mud', city: 'testville',
  });
  const names = entry.tags.map((t) => t[0]);
  assert.deepEqual(entry.tags.find((t) => t[0] === 'role'), ['role', 'aggregator']);
  assert.ok(!names.includes('p'));
  // Luma's calendar link (luma.com/calendar/<id>) leads nowhere for a place.
  assert.ok(!names.includes('luma-id'));
  assert.deepEqual(entry.tags.find((t) => t[0] === 'location'), ['location', 'Testville, US']);
});

// A Luma listing page (a category, or /discover) as it carries its data:
// calendars, each with the place it states, if any.
interface ListedCal { cal: string; name?: string; personal?: boolean; access?: string; city?: string; country?: string; lat?: number; lon?: number }
const calendarObject = (c: ListedCal) => ({
  api_id: c.cal, name: c.name ?? `Calendar ${c.cal}`, slug: null, access_level: c.access ?? 'public', is_personal: c.personal ?? false,
  location: c.city ? { city: c.city, region: null, country: c.country ?? 'United States', timezone: 'UTC' } : null,
  coordinate: c.lat === undefined ? null : { latitude: c.lat, longitude: c.lon },
});
function listingPage(timeline: ListedCal[], featured: ListedCal[] = [], kind: 'category' | 'discover' = 'category'): string {
  const initialData = kind === 'category'
    ? { kind: 'category', data: { category: { api_id: 'cat-tech', slug: 'tech', name: 'Tech' }, timeline_calendars: timeline.map((c) => ({ calendar: calendarObject(c) })), featured_calendars: featured.map((c) => ({ calendar: calendarObject(c) })) } }
    : { places: [], calendars: [...timeline, ...featured].map((c) => ({ calendar: calendarObject(c) })), categories: [] };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData } } })}</script></body></html>`;
}
const TECH = { slug: 'tech', url: 'https://luma.com/tech' };
const DISCOVER = { slug: 'discover', url: 'https://luma.com/discover' };

test('a Luma listing page names its calendars, each with the place it states', () => {
  const page = listingPage([{ cal: 'cal-Oslo0000000001', name: 'Oslo Week', city: 'Oslo', country: 'Norway', lat: 59.9121746, lon: 10.7312704 }], [{ cal: 'cal-Global00000001', name: 'Global Meetups' }]);
  assert.deepEqual(lumaListedCalendars(page), [
    { id: 'cal-Global00000001', name: 'Global Meetups', slug: null, personal: false, access: 'public', place: null },
    { id: 'cal-Oslo0000000001', name: 'Oslo Week', slug: null, personal: false, access: 'public', place: { city: 'Oslo', country: 'Norway', latitude: 59.9121746, longitude: 10.7312704 } },
  ]);
  assert.equal(lumaListedCalendars(listingPage([{ cal: 'cal-Disc000000001' }], [], 'discover')).length, 1);
  assert.deepEqual(lumaListedCalendars('<html>no data</html>'), []);
});

test('discovery reads each listed page every six hours and files its calendars under the place each states; one with none is Worldwide, with no g', async () => {
  const s = setup({
    pages: {
      [TECH.url]: listingPage(
        [{ cal: 'cal-Oslo0000000001', name: 'Oslo Week', city: 'Oslo', country: 'Norway', lat: 59.9121746, lon: 10.7312704 }, { cal: 'cal-Pers000000001', name: 'Personal', personal: true }],
        [{ cal: 'cal-Global00000001', name: 'Global Meetups' }, { cal: 'cal-Austin0000001', city: 'Austin', country: 'United States', lat: 30.267153, lon: -97.743061 }],
      ),
    },
    feeds: {
      [calendarUrl('cal-Oslo0000000001')]: calendarFeed('Oslo Week'),
      [calendarUrl('cal-Global00000001')]: calendarFeed('Global Meetups'),
      [calendarUrl('cal-Austin0000001')]: calendarFeed('Austin Builders'),
    },
    listed: [TECH],
    noAggregator: true,
  });
  await drain(s.discovery, NOW);
  const oslo = s.dir.get('luma:cal-Oslo0000000001')!;
  assert.deepEqual([oslo.location, oslo.g, oslo.foundVia], ['Oslo, NO', 'u4xs', 'luma-page:tech']);
  const global = s.dir.get('luma:cal-Global00000001')!;
  assert.deepEqual([global.location, global.g], ['Worldwide', null]);
  assert.equal(s.dir.get('luma:cal-Austin0000001')!.location, 'Austin, US');
  assert.equal(s.dir.get('luma:cal-Pers000000001'), null);
  assert.equal(s.found.get('luma:cal-Pers000000001')!.reason, 'platform-default-calendar');
  assert.ok(!s.fetched.includes(calendarUrl('cal-Pers000000001')), 'a personal calendar\'s feed is never fetched');
  const reads = () => s.fetched.filter((u) => u === TECH.url).length;
  await drain(s.discovery, NOW + DISCOVERY_INTERVAL - 1);
  assert.equal(reads(), 1);
  await drain(s.discovery, NOW + DISCOVERY_INTERVAL);
  assert.equal(reads(), 2, 'read again six hours on');
});

test('listed pages and city pages take turns, one page a step, under the same caps', async () => {
  const s = setup({
    pages: { [PAGE_URL]: cityPage([{ cal: 'cal-City000000001' }]), [DISCOVER.url]: listingPage([{ cal: 'cal-Disc000000001' }, { cal: 'cal-Disc000000002' }], [], 'discover') },
    feeds: Object.fromEntries(['cal-City000000001', 'cal-Disc000000001', 'cal-Disc000000002'].map((id) => [calendarUrl(id), calendarFeed(id)])),
    listed: [DISCOVER],
    settings: { perRun: 1 },
  });
  const first = await s.discovery.step(NOW);
  const second = await s.discovery.step(NOW);
  assert.deepEqual([first.page?.place, second.page?.place].sort(), ['luma-page:discover', `luma:${PLACE.api_id}`].sort());
  await drain(s.discovery, NOW);
  assert.ok(s.dir.get('luma:cal-City000000001'));
  assert.equal(['cal-Disc000000001', 'cal-Disc000000002'].filter((id) => s.dir.get(`luma:${id}`)).length, 1, 'the cap of one a run holds for a listed page');
});

test('a stated place is its city and its country\'s code; a country Luma names otherwise keeps its name', () => {
  const at = (city: string, country: string | null) => areaOf({ city, country, latitude: null, longitude: null }).location;
  assert.equal(at('Paris', 'France'), 'Paris, FR');
  assert.equal(at('Hong Kong', 'Hong Kong'), 'Hong Kong, HK');
  assert.equal(at('Istanbul', 'Turkey'), 'Istanbul, TR');
  assert.equal(at('New York', 'United States'), 'New York, US');
  assert.equal(at('Cottbus', 'Deutschland'), 'Cottbus, DE', 'a country named in its own language');
  assert.equal(at('Utrecht', 'Nederland'), 'Utrecht, NL');
  assert.equal(at('Bilbao', 'España'), 'Bilbao, ES');
  assert.equal(at('Graz', 'Österreich'), 'Graz, AT');
  assert.equal(at('Bergen', 'Noreg'), 'Bergen, NO');
  assert.equal(at('Atlantis', 'Atlantica'), 'Atlantis, Atlantica');
  assert.equal(at('Somewhere', null), 'Somewhere');
  assert.deepEqual(areaOf(null), { location: 'Worldwide', g: null });
});
