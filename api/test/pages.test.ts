import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, type Harness } from './harness.ts';
import { readFixture } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const local = (d: string) => h.dir.get(d)!.localName;
let ip = 0;
const from = () => ({ 'x-real-ip': `203.0.113.${(ip += 1)}` });

const brand = new URL('../../brand/', import.meta.url).pathname;

function plainPage(response: Response, html: string): void {
  assert.match(response.headers.get('content-type')!, /^text\/html; charset=utf-8/);
  const csp = response.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'self'/);
  assert.ok(!/<script|<iframe|https?:\/\/[^"'\s]*\.(js|css)\b/i.test(html), 'no scripts, frames or third-party assets');
  for (const [, src] of html.matchAll(/<(?:img|source)[^>]+(?:src|srcset)="([^"]+)"/g)) assert.match(src!, /^\/brand\//, 'only the site\'s own images');
  assert.ok(!/analytics|gtag|plausible|matomo|pixel/i.test(html), 'no tracking');
  // The icons and the header wordmark on every page.
  for (const tag of ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">', '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">', '<meta name="theme-color" content="#1f5fbf">',
    '<source srcset="/brand/wordmark-dark.svg" media="(prefers-color-scheme: dark)">', '<img src="/brand/wordmark-light.svg" alt="Event Index" height="32">']) {
    assert.ok(html.includes(tag), tag);
  }
}

test('the one page: what it is, search, submit, the API, stats and the dump', async () => {
  const response = await h.get('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  plainPage(response, html);
  assert.match(html, /<a href="\/" aria-label="Event Index home">\s*<picture>/);
  assert.match(html, /<h1>An open directory of public event calendars\.<\/h1>/);
  assert.match(html, /<form[^>]+action="\/search"[^>]+method="get"/);
  assert.match(html, /<form[^>]+action="\/submit"[^>]+method="post"/);
  assert.match(html, /https:\/\/api\.eventindex\.space\/api\/1\.0/);
  assert.match(html, /href="https:\/\/api\.eventindex\.space\/api\/1\.0\/dump\/index\.db"/);
  assert.match(html, /<strong>5<\/strong> calendars/);
  assert.match(html, /\/\.well-known\/nostr\.json/);
  assert.match(html, /CC0/);
  const css = await h.get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type')!, /^text\/css/);
});

test('directory search as a page', async () => {
  const response = await h.get('/search?q=python');
  const html = await response.text();
  plainPage(response, html);
  assert.match(html, new RegExp(`href="/calendar/${local('meetup:pythonsd')}"`));
  assert.match(html, /San Diego Python Users Group/);
  const none = await (await h.get('/search?q=zzzz')).text();
  assert.match(none, /No calendars match/);
});

test('a calendar\'s page: its events under its content policy, and the remove form', async () => {
  const name = local('meetup:pythonsd');
  const response = await h.get(`/calendar/${name}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  plainPage(response, html);
  assert.match(html, /<h1>San Diego Python Users Group<\/h1>/);
  assert.match(html, /Meetup®/);
  assert.match(html, /not affiliated with Meetup/);
  assert.match(html, new RegExp(`<form[^>]+action="/calendar/${name}/remove"[^>]+method="post"`));
  assert.match(html, new RegExp(`/api/1.0/ics/calendar/${name}.ics`));
  assert.match(html, /npub1/);
  assert.equal((html.match(/<li class="event">/g) ?? []).length, 4);
  const full = readFixture('meetup-pythonsd.ics');
  assert.ok(full.length > 0);
  for (const description of html.match(/<p class="summary">([^<]*)<\/p>/g) ?? []) {
    assert.ok([...new Intl.Segmenter().segment(description.replace(/<[^>]+>/g, ''))].length <= 280);
  }
});

test('a hidden venue shows no place on the page', async () => {
  const html = await (await h.get(`/calendar/${local('luma:cal-BvuRd9eaZnDGBwy')}`)).text();
  const item = html.split('<li class="event">').find((part) => part.includes('qrippy6usrk5uthpkimlg63ybc7alyzo'))!;
  assert.ok(item, 'the hidden-venue event is listed');
  assert.ok(!/class="where"/.test(item.split('</li>')[0]!));
});

test('the remove form answers with the token and what happens next', async () => {
  const name = local('mobilizon:mobilizon.fr/@lyontechhub');
  const response = await h.post(`/calendar/${name}/remove`, 'message=Please+remove+us', from());
  const html = await response.text();
  assert.equal(response.status, 202);
  plainPage(response, html);
  const token = h.queues.removals('pending').find((r) => r.d === 'mobilizon:mobilizon.fr/@lyontechhub')!.token;
  assert.ok(html.includes(token));
  assert.match(html, /maintainer/);
});

test('the submit form answers in a page', async () => {
  const url = 'https://example.org/cal.ics';
  h.feeds.set(url, { status: 'ok', text: readFixture('synthetic/rich.ics'), etag: null, lastModified: null, finalUrl: url });
  const ok = await h.post('/submit', `url=${encodeURIComponent(url)}`, from());
  const html = await ok.text();
  plainPage(ok, html);
  assert.equal(ok.status, 202);
  assert.match(html, /Rich Calendar/);
  assert.match(html, /review/);
  const bad = await h.post('/submit', 'url=https%3A%2F%2Fexample.org%2Fnope.ics', from());
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /could not be read/);
});

test('pages escape what feeds say', async () => {
  h.dir.setMeta('meetup:pythonsd', { name: '<b>Python</b> & "friends"', description: null, url: null, image: null });
  const html = await (await h.get(`/calendar/${local('meetup:pythonsd')}`)).text();
  assert.ok(html.includes('&lt;b&gt;Python&lt;/b&gt; &amp; &quot;friends&quot;'));
  assert.ok(!html.includes('<b>Python</b>'));
});

test('unknown calendar pages are 404 pages', async () => {
  const response = await h.get('/calendar/no-such-calendar');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type')!, /^text\/html/);
});

test('the favicon files are served at the root, and the mark and wordmark under /brand/', async () => {
  const files: Array<[string, string, string]> = [
    ['/favicon.svg', 'favicon/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'favicon/favicon.ico', 'image/x-icon'],
    ['/apple-touch-icon.png', 'favicon/apple-touch-icon.png', 'image/png'],
    ['/android-chrome-512x512.png', 'favicon/android-chrome-512x512.png', 'image/png'],
    ['/site.webmanifest', 'favicon/site.webmanifest', 'application/manifest+json'],
    ['/brand/mark-tile-512.png', 'mark/mark-tile-512.png', 'image/png'],
    ['/brand/wordmark-light.svg', 'wordmark/wordmark-light.svg', 'image/svg+xml'],
    ['/brand/wordmark-dark.svg', 'wordmark/wordmark-dark.svg', 'image/svg+xml'],
  ];
  for (const [path, file, type] of files) {
    const response = await h.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type')!.split(';')[0], type, path);
    assert.match(response.headers.get('cache-control')!, /max-age=86400/, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(`${brand}${file}`), path);
    if (type === 'image/svg+xml') assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/, path);
  }
  for (const path of ['/brand/../package.json', '/brand/LICENSE', '/brand/README.md', '/brand/geometry.json', '/brand/nothing.png', '/brand/tools/raster.mjs', '/mark.svg']) {
    assert.equal((await h.get(path)).status, 404, path);
  }
});
