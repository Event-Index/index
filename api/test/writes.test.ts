import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from './harness.ts';
import type { IncomingMessage } from 'node:http';
import { approveRemoval } from '../../indexer/src/service/admin.ts';
import { clientAddress } from '../src/server.ts';
import { readFixture, NOW } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness({ queueCap: 3 }); });
after(() => h.close());

const API = '/api/1.0';
const local = (d: string) => h.dir.get(d)!.localName;
let ip = 0;
// Each test speaks from its own address, so rate limits do not leak between tests.
const from = () => ({ 'x-real-ip': `198.51.100.${(ip += 1)}` });
const GOOGLE = 'https://example.org/python-events.ics';

test('a submitted feed from an unknown host is validated and queued for review, not indexed', async () => {
  h.feeds.set(GOOGLE, { status: 'ok', text: readFixture('google-python-events.ics'), etag: null, lastModified: null, finalUrl: GOOGLE });
  const headers = from();
  const response = await h.post(`${API}/feeds/add`, { url: GOOGLE }, headers);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json() as any;
  assert.equal(body.status, 'queued');
  assert.equal(body.name, 'Python Events Calendar');
  assert.equal(body.source, 'ics');
  assert.match(body.message, /review/);
  assert.equal(h.dir.get(body.d), null, 'not in the directory before review');
  assert.equal(h.queues.submissions('pending').length, 1);
  const again = await h.post(`${API}/feeds/add?url=${encodeURIComponent(GOOGLE)}`, {}, headers);
  assert.equal(again.status, 202);
  assert.equal(((await again.json()) as any).status, 'already-queued');
});

test('a submission is refused when it is listed, on the do-not-index list, private, unreachable or not a calendar', async () => {
  const cases: Array<[string, number, string]> = [
    ['https://www.meetup.com/pythonsd/events/ical/', 409, 'already-listed'],
    ['https://calendar.google.com/calendar/ical/someone%40gmail.com/private-0123456789abcdef/basic.ics', 400, 'private-feed-url'],
    ['https://example.org/feed.ics?token=abc', 400, 'private-feed-url'],
    ['not a url', 400, 'invalid-url'],
    ['https://example.org/missing.ics', 422, 'http-404'],
    ['https://example.org/page.ics', 422, 'not-icalendar'],
  ];
  h.feeds.set('https://example.org/page.ics', { status: 'ok', text: '<html>hello</html>', etag: null, lastModified: null, finalUrl: 'https://example.org/page.ics' });
  for (const [url, status, code] of cases) {
    const response = await h.post(`${API}/feeds/add`, { url }, from());
    assert.equal(response.status, status, url);
    assert.equal(((await response.json()) as any).error, code, url);
  }
  h.dir.block('meetup:blocked', 'organizer request', NOW);
  const blocked = await h.post(`${API}/feeds/add`, { url: 'https://www.meetup.com/blocked/events/ical/' }, from());
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as any).error, 'not-indexed');
  assert.equal((await h.post(`${API}/feeds/add`, {}, from())).status, 400);
  assert.equal((await h.post(`${API}/feeds/add`, '{"url":', { ...from(), 'content-type': 'application/json' })).status, 400);
});

test('submissions are rate-limited per address, and the queue has a cap', async () => {
  const headers = from();
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) codes.push((await h.post(`${API}/feeds/add`, { url: `https://example.org/n${i}.ics` }, headers)).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(422));
  assert.equal(codes[10], 429);
  const limited = await h.post(`${API}/feeds/add`, { url: 'https://example.org/x.ics' }, headers);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await h.post(`${API}/feeds/add`, { url: 'https://example.org/x.ics' }, from())).status, 422, 'another address is not limited');

  for (const n of [1, 2, 3]) {
    const url = `https://example.org/cal${n}.ics`;
    h.feeds.set(url, { status: 'ok', text: readFixture('synthetic/rich.ics'), etag: null, lastModified: null, finalUrl: url });
  }
  const statuses = [];
  for (const n of [1, 2, 3]) statuses.push((await h.post(`${API}/feeds/add`, { url: `https://example.org/cal${n}.ics` }, from())).status);
  assert.deepEqual(statuses, [202, 202, 503], 'the cap counts every pending submission');
});

test('the remove flow: a request with a token, a maintainer\'s approval, the poll service\'s removal', async () => {
  const name = local('meetup:pythonsd');
  const response = await h.post(`${API}/calendars/${name}/remove-request`, { message: 'We run this group and would rather not be listed.' }, from());
  assert.equal(response.status, 202);
  const body = await response.json() as any;
  assert.equal(body.status, 'received');
  assert.match(body.token, /^eventindex-remove-[a-z2-7]{10}$/);
  assert.match(body.instructions, new RegExp(body.token));
  const [request] = h.queues.removals('pending');
  assert.equal(request!.d, 'meetup:pythonsd');
  assert.equal(request!.message, 'We run this group and would rather not be listed.');

  const listed = await (await h.get(`${API}/calendars/byslug/${name}`)).json() as any;
  assert.equal(listed.eventindex.removed, false, 'nothing changes before review');

  approveRemoval(h, request!.id, NOW);
  const report = await h.indexer.tick();
  assert.deepEqual(report.removed, ['meetup:pythonsd']);

  const removed = await (await h.get(`${API}/calendars/byslug/${name}`)).json() as any;
  assert.equal(removed.eventindex.removed, true);
  assert.equal(removed.eventindex.event_count, 0);
  assert.equal((await h.get(`${API}/events/bycalendar/${name}`)).status, 410);
  assert.equal((await h.get(`${API}/ics/calendar/${name}.ics`)).status, 410);
  const anEvent = h.db.recordsOf('meetup:pythonsd')[0]!.id;
  assert.equal((await h.get(`${API}/events/byid/${anEvent}.ics`)).status, 410);
  const search = await (await h.get(`${API}/search/calendars/byterm?q=python`)).json() as any;
  assert.equal(search.count, 0);
  assert.equal((await h.post(`${API}/calendars/${name}/remove-request`, {}, from())).status, 410);
  const resubmit = await h.post(`${API}/feeds/add`, { url: 'https://www.meetup.com/pythonsd/events/ical/' }, from());
  assert.equal(((await resubmit.json()) as any).error, 'not-indexed');
});

test('a remove request needs a listed calendar and a short message, and is rate-limited', async () => {
  assert.equal((await h.post(`${API}/calendars/no-such-calendar/remove-request`, {}, from())).status, 404);
  const name = local('mobilizon:mobilizon.fr/@lyontechhub');
  assert.equal((await h.post(`${API}/calendars/${name}/remove-request`, { message: 'x'.repeat(1001) }, from())).status, 400);
  const headers = from();
  const codes = [];
  for (let i = 0; i < 6; i += 1) codes.push((await h.post(`${API}/calendars/${name}/remove-request`, {}, headers)).status);
  assert.deepEqual(codes, [202, 202, 202, 202, 202, 429]);
});

test('the limiter keys on the address the local proxy forwards', async () => {
  // Requests in these tests come from 127.0.0.1, the proxy's address, so
  // X-Real-IP is honored; from anywhere else the socket address is used.
  const a = from();
  for (let i = 0; i < 10; i += 1) await h.post(`${API}/feeds/add`, { url: 'https://example.org/y.ics' }, a);
  assert.equal((await h.post(`${API}/feeds/add`, { url: 'https://example.org/y.ics' }, a)).status, 429);
  assert.equal((await h.post(`${API}/feeds/add`, { url: 'https://example.org/y.ics' }, from())).status, 422);
});

test('bodies over 16 KiB are refused', async () => {
  const response = await h.post(`${API}/feeds/add`, { url: `https://example.org/${'a'.repeat(17000)}` }, from());
  assert.equal(response.status, 413);
});

test('a forwarded address is ignored unless the request comes from the local proxy', () => {
  const req = (remoteAddress: string) => ({ socket: { remoteAddress }, headers: { 'x-real-ip': '192.0.2.7' } }) as unknown as IncomingMessage;
  assert.equal(clientAddress(req('127.0.0.1')), '192.0.2.7');
  assert.equal(clientAddress(req('::1')), '192.0.2.7');
  assert.equal(clientAddress(req('203.0.113.9')), '203.0.113.9');
});
