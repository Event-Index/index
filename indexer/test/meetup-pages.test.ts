import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIndexDb } from '../src/store/index-db.ts';
import { eventPagesStore } from '../src/store/event-pages.ts';
import { createPageReader, ROBOTS_URL } from '../src/enrich/meetup-pages.ts';
import type { FetchResult, Validators } from '../src/poller/fetch.ts';
import { readPage, NOW } from './helpers.ts';

const PAGE = 'https://www.meetup.com/example-group/events/100000001/';
const VENUE = readPage('synthetic/meetup-venue.html');
const FEED = { location: null, status: 'CONFIRMED', stamp: '2026-10-07T23:15:35Z|1' };

function setup(answers: Record<string, FetchResult | ((v: Validators) => FetchResult)> = {}) {
  const db = openIndexDb(':memory:');
  const store = eventPagesStore(db);
  const requests: Array<{ url: string; validators: Validators }> = [];
  const log: string[] = [];
  const responses: Record<string, FetchResult | ((v: Validators) => FetchResult)> = {
    [ROBOTS_URL]: { status: 'ok', text: 'User-agent: *\nDisallow: /_next/data/*\n', etag: null, lastModified: null, finalUrl: ROBOTS_URL },
    [PAGE]: { status: 'ok', text: VENUE, etag: 'W/"v1"', lastModified: null, finalUrl: PAGE },
    ...answers,
  };
  const reader = createPageReader({
    store,
    fetch: async (url, validators) => {
      requests.push({ url, validators });
      const r = responses[url];
      return typeof r === 'function' ? r(validators) : r ?? { status: 'error', code: 'http-404' };
    },
    log: (line) => log.push(line),
  });
  const observe = (stamp = FEED.stamp, url = PAGE, start = NOW + 7 * 86400) =>
    store.observe({ calendarD: 'meetup:example-group', uid: 'event_100000001@meetup.com', url, start, end: start + 7200, feed: { ...FEED, stamp } });
  return { db, store, reader, requests, log, responses, observe };
}

test('an event\'s page is read once when the event is first seen, after robots.txt, and not again while the feed says the same', async () => {
  const t = setup();
  t.observe();
  const changed = await t.reader.step(NOW, 4);
  assert.deepEqual(t.requests.map((r) => r.url), [ROBOTS_URL, PAGE]);
  assert.deepEqual(changed, [{ calendarD: 'meetup:example-group', uid: 'event_100000001@meetup.com' }]);
  assert.deepEqual(t.store.get('meetup:example-group', 'event_100000001@meetup.com')!.facts, { location: 'Example Hall, 100 Example Way, San Diego, CA', cancelled: false });
  t.observe();
  assert.deepEqual(await t.reader.step(NOW + 600, 4), []);
  assert.equal(t.requests.length, 2, 'nothing more is requested');
});

test('a new LAST-MODIFIED or SEQUENCE reads the page again, conditionally; a 304 keeps what was read', async () => {
  const t = setup();
  t.observe();
  await t.reader.step(NOW, 4);
  t.responses[PAGE] = { status: 'not-modified' };
  t.observe('2026-10-07T23:15:35Z|2');
  assert.deepEqual(await t.reader.step(NOW + 60, 4), []);
  assert.deepEqual(t.requests.at(-1), { url: PAGE, validators: { etag: 'W/"v1"', lastModified: null } });
  assert.equal(t.store.get('meetup:example-group', 'event_100000001@meetup.com')!.facts!.location, 'Example Hall, 100 Example Way, San Diego, CA');
  assert.deepEqual(await t.reader.step(NOW + 120, 4), []);
  assert.equal(t.requests.filter((r) => r.url === PAGE).length, 2);
});

test('robots.txt is read again after a day, and a page it disallows is never requested', async () => {
  const t = setup({ [ROBOTS_URL]: { status: 'ok', text: 'User-agent: *\nDisallow: /example-group/\n', etag: null, lastModified: null, finalUrl: ROBOTS_URL } });
  t.observe();
  assert.deepEqual(await t.reader.step(NOW, 4), []);
  assert.deepEqual(t.requests.map((r) => r.url), [ROBOTS_URL]);
  assert.equal(t.store.get('meetup:example-group', 'event_100000001@meetup.com')!.outcome, 'disallowed');
  t.observe('2026-10-07T23:15:35Z|2');
  await t.reader.step(NOW + 3600, 4);
  assert.deepEqual(t.requests.map((r) => r.url), [ROBOTS_URL], 'the day-old copy still holds');
  t.observe('2026-10-07T23:15:35Z|3');
  await t.reader.step(NOW + 86400 + 1, 4);
  assert.deepEqual(t.requests.map((r) => r.url), [ROBOTS_URL, ROBOTS_URL]);
});

test('a robots.txt the site does not have allows; one it cannot serve holds every page back', async () => {
  const missing = setup({ [ROBOTS_URL]: { status: 'error', code: 'http-404' } });
  missing.observe();
  await missing.reader.step(NOW, 4);
  assert.deepEqual(missing.requests.map((r) => r.url), [ROBOTS_URL, PAGE]);
  const down = setup({ [ROBOTS_URL]: { status: 'error', code: 'http-503' } });
  down.observe();
  await down.reader.step(NOW, 4);
  await down.reader.step(NOW + 60, 4);
  assert.deepEqual(down.requests.map((r) => r.url), [ROBOTS_URL], 'retried only after an hour');
  await down.reader.step(NOW + 3601, 4);
  assert.deepEqual(down.requests.map((r) => r.url), [ROBOTS_URL, ROBOTS_URL]);
});

test('past events are not read', async () => {
  const t = setup();
  t.observe(FEED.stamp, PAGE, NOW - 86400);
  assert.deepEqual(await t.reader.step(NOW, 4), []);
  assert.equal(t.requests.length, 0);
});

test('a 403 or 429 backs off, longer each time; five in a row stop reading until resumed', async () => {
  const t = setup({ [PAGE]: { status: 'error', code: 'http-429', retryAfter: NOW + 1200 } });
  t.observe();
  await t.reader.step(NOW, 4);
  assert.equal(t.requests.filter((r) => r.url === PAGE).length, 1, 'the step stops at the first refusal');
  await t.reader.step(NOW + 1000, 4);
  assert.equal(t.requests.filter((r) => r.url === PAGE).length, 1, 'Retry-After is waited out');
  let at = NOW + 1201;
  for (let strike = 2; strike <= 5; strike += 1) {
    t.responses[PAGE] = { status: 'error', code: strike % 2 ? 'http-429' : 'http-403' };
    await t.reader.step(at, 4);
    assert.equal(t.requests.filter((r) => r.url === PAGE).length, strike);
    at += 600 * 2 ** (strike - 1) + 1;
  }
  assert.ok(t.store.state().stoppedAt, 'stopped');
  assert.ok(t.log.some((l) => /stopped/.test(l)));
  await t.reader.step(at + 86400, 4);
  assert.equal(t.requests.filter((r) => r.url === PAGE).length, 5, 'nothing while stopped');
  t.store.resume();
  t.responses[PAGE] = { status: 'ok', text: VENUE, etag: null, lastModified: null, finalUrl: PAGE };
  await t.reader.step(at + 86400, 4);
  assert.equal(t.store.get('meetup:example-group', 'event_100000001@meetup.com')!.outcome, 'read');
  assert.equal(t.store.state().strikes, 0);
});

test('a page that is gone gives nothing; a failed read is tried again later, then left for that version', async () => {
  const gone = setup({ [PAGE]: { status: 'error', code: 'http-404' } });
  gone.observe();
  assert.deepEqual(await gone.reader.step(NOW, 4), []);
  assert.equal(gone.store.get('meetup:example-group', 'event_100000001@meetup.com')!.outcome, 'gone');
  await gone.reader.step(NOW + 7200, 4);
  assert.equal(gone.requests.filter((r) => r.url === PAGE).length, 1);

  const flaky = setup({ [PAGE]: { status: 'error', code: 'timeout' } });
  flaky.observe();
  let at = NOW;
  for (let i = 0; i < 6; i += 1) {
    await flaky.reader.step(at, 4);
    at += 3601;
  }
  assert.equal(flaky.requests.filter((r) => r.url === PAGE).length, 5);
  assert.equal(flaky.store.get('meetup:example-group', 'event_100000001@meetup.com')!.outcome, 'failed');
  flaky.observe('2026-10-07T23:15:35Z|2');
  await flaky.reader.step(at, 4);
  assert.equal(flaky.requests.filter((r) => r.url === PAGE).length, 6, 'a new version is read again');
});

test('a step reads at most its limit, soonest events first', async () => {
  const t = setup();
  for (let i = 1; i <= 6; i += 1) {
    const url = `https://www.meetup.com/example-group/events/10000000${i}/`;
    t.responses[url] = { status: 'ok', text: VENUE, etag: null, lastModified: null, finalUrl: url };
    t.store.observe({ calendarD: 'meetup:example-group', uid: `event_${i}@meetup.com`, url, start: NOW + (10 - i) * 86400, end: NOW + (10 - i) * 86400 + 3600, feed: FEED });
  }
  await t.reader.step(NOW, 3);
  assert.deepEqual(t.requests.slice(1).map((r) => r.url.split('/')[5]), ['100000006', '100000005', '100000004']);
});
