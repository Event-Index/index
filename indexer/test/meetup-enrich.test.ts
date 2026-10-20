import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import ICAL from 'ical.js';
import { generateSecretKey, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb, type IndexDb } from '../src/store/index-db.ts';
import { openVault, type Vault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { eventPagesStore } from '../src/store/event-pages.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import { ROBOTS_URL } from '../src/enrich/meetup-pages.ts';
import type { FetchResult, Validators } from '../src/poller/fetch.ts';
import { readFixture, readPage, feedUrlFor, NOW } from './helpers.ts';

const HEADER = `39998:${'ab'.repeat(32)}:events`;
const FEED = identify(feedUrlFor('meetup-pythonsd.ics'));
const ITEMS = { EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER };
const ON = { ...ITEMS, EVENTINDEX_MEETUP_PAGES: '1' };
const page = (id: string) => `https://www.meetup.com/pythonsd/events/${id}/`;
const VENUE = 'Example Hall, 100 Example Way, San Diego, CA';

interface Stores { db: IndexDb; vault: Vault; indexKey: Uint8Array }
const stores = (): Stores => ({ db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey() });

function service(s: Stores, env: Record<string, string>, feedText = readFixture('meetup-pythonsd.ics')) {
  const dir = directoryStore(s.db);
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const requests: Array<{ url: string; validators: Validators }> = [];
  const pages: Record<string, FetchResult> = {
    [ROBOTS_URL]: { status: 'ok', text: 'User-agent: *\nDisallow: /_next/data/*\n', etag: null, lastModified: null, finalUrl: ROBOTS_URL },
    [page('312775793')]: { status: 'ok', text: readPage('synthetic/meetup-venue.html'), etag: 'W/"v1"', lastModified: null, finalUrl: page('312775793') },
    [page('316721984')]: { status: 'ok', text: readPage('synthetic/meetup-online.html'), etag: null, lastModified: null, finalUrl: page('316721984') },
    [page('316721985')]: { status: 'ok', text: readPage('synthetic/meetup-members-only.html'), etag: null, lastModified: null, finalUrl: page('316721985') },
  };
  const feed = { text: feedText };
  const clock = { now: NOW };
  const indexer = createIndexer({
    db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...env }),
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => (url === FEED.feedUrl ? { status: 'ok', text: feed.text, etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' }),
    fetchPage: async (url, validators) => {
      requests.push({ url, validators });
      return pages[url] ?? { status: 'error', code: 'http-404' };
    },
    publisher: { publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))), rsvps: async () => new Set(), close: () => {} },
    log: () => {},
  });
  if (!dir.get(FEED.d)) dir.add({ ...FEED, name: null, description: null, image: null, location: 'San Diego, US', g: '9mud', foundVia: 'maintainer', addedAt: NOW - 86400 });
  return { dir, sent, requests, pages, feed, clock, indexer, events: eventStore(s.db) };
}

const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === HEADER);
const tag = (e: VerifiedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const rowOf = (svc: ReturnType<typeof service>, id: string) => svc.events.byCalendar(FEED.d, NOW - 86400, NOW + 400 * 86400).find((r) => r.url === page(id))!;
const itemOf = (svc: ReturnType<typeof service>, id: string) => svc.sent.filter((x) => x.audience === 'own' && isItem(x.event) && tag(x.event, 'd') === rowOf(svc, id).id).at(-1)?.event;
function vevent(s: Stores, svc: ReturnType<typeof service>, id: string) {
  const record = s.db.record(rowOf(svc, id).recordId)!;
  return new ICAL.Component(ICAL.parse(record.ics)).getFirstSubcomponent('vevent')!;
}
const pollAgain = (s: Stores) => s.db.savePollState(FEED.d, { ...s.db.pollState(FEED.d), nextPollAt: 0, etag: null, lastModified: null });

test('a Meetup event gets the venue its page shows: in its record, marked, in its row and its item as text, with no point', async () => {
  const s = stores();
  const svc = service(s, ON);
  await svc.indexer.tick();
  assert.equal(svc.requests[0]!.url, ROBOTS_URL, 'robots.txt first');
  assert.deepEqual(svc.requests.slice(1).map((r) => r.url).sort(), [page('312775793'), page('316721984'), page('316721985'), page('nqgrvtyjcqbhb')].sort());

  const venue = vevent(s, svc, '312775793');
  assert.equal(venue.getFirstPropertyValue('location'), VENUE);
  assert.equal(venue.getFirstProperty('x-eventindex-enriched')!.getFirstValue(), page('312775793'));
  assert.equal(venue.getFirstPropertyValue('geo'), null);
  assert.equal(rowOf(svc, '312775793').location, VENUE);
  assert.equal(rowOf(svc, '312775793').g, null);
  const item = itemOf(svc, '312775793')!;
  assert.equal(tag(item, 'location'), VENUE);
  assert.equal(tag(item, 'g'), undefined, 'still no point');

  assert.equal(tag(itemOf(svc, '316721984')!, 'location'), 'Online');
  const hidden = vevent(s, svc, '316721985');
  assert.equal(hidden.getFirstPropertyValue('location'), null, 'a venue the page hides is not taken');
  assert.equal(hidden.getFirstProperty('x-eventindex-enriched'), null);
  assert.equal(vevent(s, svc, 'nqgrvtyjcqbhb').getFirstPropertyValue('location'), null);
});

test('a page is not read again until the feed changes the event, then conditionally; a cancellation there cancels the item', async () => {
  const s = stores();
  const svc = service(s, ON);
  await svc.indexer.tick();
  const read = svc.requests.length;
  const published = svc.sent.length;
  // Items are looked at again every ten minutes.
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  assert.equal(svc.requests.length, read, 'nothing is read again');
  assert.equal(svc.sent.filter((x) => isItem(x.event)).length, svc.sent.slice(0, published).filter((x) => isItem(x.event)).length, 'no item changes');

  svc.feed.text = svc.feed.text.replace('LAST-MODIFIED:20260107T231535Z', 'LAST-MODIFIED:20261016T120000Z');
  svc.pages[page('312775793')] = { status: 'ok', text: readPage('synthetic/meetup-venue.html').replace('EventScheduled', 'EventCancelled'), etag: 'W/"v2"', lastModified: null, finalUrl: page('312775793') };
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  assert.deepEqual(svc.requests.slice(read), [{ url: page('312775793'), validators: { etag: 'W/"v1"', lastModified: null } }]);
  const cancelled = vevent(s, svc, '312775793');
  assert.equal(cancelled.getFirstPropertyValue('status'), 'CANCELLED');
  assert.equal(cancelled.getFirstProperty('x-eventindex-enriched')!.getParameter('x-eventindex-properties'), 'LOCATION,STATUS');
  const item = itemOf(svc, '312775793')!;
  assert.equal(tag(item, 'status'), 'cancelled');
  assert.match(tag(item, 'title')!, /^Cancelled: /);
});

test('events stored before pages were read are read after a restart, once; a poll keeps what was read', async () => {
  const s = stores();
  const off = service(s, ITEMS);
  await off.indexer.tick();
  assert.equal(off.requests.length, 0, 'off by default');
  assert.equal(rowOf(off, '312775793').location, null);

  const on = service(s, ON);
  on.clock.now += 120;
  await on.indexer.tick();
  assert.ok(on.requests.some((r) => r.url === page('312775793')), 'read without a new poll');
  assert.equal(rowOf(on, '312775793').location, VENUE);
  assert.equal(tag(itemOf(on, '312775793')!, 'location'), VENUE);

  const again = service(s, ON);
  again.clock.now += 180;
  pollAgain(s);
  await again.indexer.tick();
  assert.equal(again.requests.length, 0, 'nothing read twice across restarts');
  assert.equal(rowOf(again, '312775793').location, VENUE, 'the poll applies what was read');
  assert.equal(eventPagesStore(s.db).get(FEED.d, 'event_312775793@meetup.com')!.facts!.location, VENUE);
});
