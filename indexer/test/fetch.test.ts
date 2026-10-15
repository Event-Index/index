import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { fetchFeed } from '../src/poller/fetch.ts';
import { isPublicAddress } from '../src/directory/validate.ts';
import { readFixture } from './helpers.ts';

let server: Server;
let port = 0;
const FEED = readFixture('meetup-pythonsd.ics');

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/feed.ics') {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"', 'last-modified': 'Thu, 15 Oct 2026 18:00:00 GMT' }).end(FEED);
    } else if (path === '/gzip.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' }).end(gzipSync(FEED));
    } else if (path === '/to-literal') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/feed.ics` }).end();
    } else if (path === '/to-private-feed') {
      res.writeHead(301, { location: '/calendar/ical/x%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics' }).end();
    } else if (path === '/to-feed') {
      res.writeHead(302, { location: '/feed.ics' }).end();
    } else if (path === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (path === '/big.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar' }).end('x'.repeat(5000));
    } else if (path === '/slow.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      const timer = setInterval(() => res.write('X'), 100);
      res.on('close', () => clearInterval(timer));
    } else if (path === '/busy') {
      res.writeHead(503, { 'retry-after': '120' }).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// The test server is on loopback; it is reachable only under the test host
// name, so every other check stays as in production.
const testNetwork = {
  resolve: async (host: string) => (host === 'feeds.test' ? ['127.0.0.1'] : []),
  addressAllowed: (ip: string, host: string) => (host === 'feeds.test' && ip === '127.0.0.1') || isPublicAddress(ip),
};
const url = (path: string) => `http://feeds.test:${port}${path}`;

test('a feed on a private address is refused', async () => {
  assert.deepEqual(await fetchFeed(`http://127.0.0.1:${port}/feed.ics`, {}), { status: 'error', code: 'private-address' });
  const local = await fetchFeed(`http://localhost:${port}/feed.ics`, {});
  assert.deepEqual(local, { status: 'error', code: 'private-address' });
});

test('a feed is fetched with its validators', async () => {
  const result = await fetchFeed(url('/feed.ics'), {}, testNetwork);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.text, FEED);
  assert.equal(result.etag, '"v1"');
  assert.equal(result.lastModified, 'Thu, 15 Oct 2026 18:00:00 GMT');
  assert.equal(result.finalUrl, url('/feed.ics'));
});

test('a conditional GET returns not-modified', async () => {
  assert.deepEqual(await fetchFeed(url('/feed.ics'), { etag: '"v1"' }, testNetwork), { status: 'not-modified' });
});

test('a gzip-encoded feed is decoded', async () => {
  const result = await fetchFeed(url('/gzip.ics'), {}, testNetwork);
  assert.equal(result.status === 'ok' && result.text, FEED);
});

test('redirects are followed and checked again at every hop', async () => {
  const ok = await fetchFeed(url('/to-feed'), {}, testNetwork);
  assert.equal(ok.status === 'ok' && ok.finalUrl, url('/feed.ics'));
  assert.deepEqual(await fetchFeed(url('/to-literal'), {}, testNetwork), { status: 'error', code: 'private-address' });
  assert.deepEqual(await fetchFeed(url('/to-private-feed'), {}, testNetwork), { status: 'error', code: 'private-feed-url' });
  assert.deepEqual(await fetchFeed(url('/loop'), {}, testNetwork), { status: 'error', code: 'too-many-redirects' });
});

test('a feed larger than the limit is refused', async () => {
  assert.deepEqual(await fetchFeed(url('/big.ics'), {}, { ...testNetwork, maxBytes: 1000 }), { status: 'error', code: 'too-large' });
});

test('an HTTP error carries Retry-After', async () => {
  assert.deepEqual(await fetchFeed(url('/busy'), {}, testNetwork), { status: 'error', code: 'http-503', retryAfter: 120 });
  assert.deepEqual(await fetchFeed(url('/missing'), {}, testNetwork), { status: 'error', code: 'http-404' });
});

test('a feed that never finishes is cut off at the deadline', async () => {
  const started = Date.now();
  assert.deepEqual(await fetchFeed(url('/slow.ics'), {}, { ...testNetwork, deadlineMs: 500 }), { status: 'error', code: 'timeout' });
  assert.ok(Date.now() - started < 3000);
});
