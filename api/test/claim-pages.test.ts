// The pages organizers act on with their own nostr key: claiming a calendar,
// managing one that is theirs, and adding one they publish on nostr. They
// sign in with a browser extension (NIP-07), through one script served from
// the site itself. No email anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { npubEncode } from 'nostr-tools/nip19';
import { harness, type Harness } from './harness.ts';
import { NOW } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness({ native: true }); });
after(() => h.close());

const local = (d: string) => h.dir.get(d)!.localName;

// A page that may run the site's own script, and nothing else.
function scriptedPage(response: Response, html: string): void {
  assert.match(response.headers.get('content-type')!, /^text\/html; charset=utf-8/);
  const csp = response.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((s) => s[1]!.trim()), ['src="/claim.js" defer']);
  assert.ok(scripts.every((s) => s[2] === ''), 'no inline script');
  assert.ok(!/email|e-mail/i.test(html), 'no email');
}

test('a mirrored calendar\'s page offers "Claim this calendar" beside "Remove this calendar"', async () => {
  const name = local('meetup:pythonsd');
  const html = await (await h.get(`/calendar/${name}`)).text();
  assert.match(html, new RegExp(`<a class="button" href="/calendar/${name}/claim">Claim this calendar</a>`));
  assert.match(html, /<h3>Remove this calendar<\/h3>/);
  assert.match(html, new RegExp(`<form[^>]+action="/calendar/${name}/remove"`));
  assert.ok(!/<script/.test(html), 'the calendar page itself runs no script');
});

test('the claim page signs in with the organizer\'s key and offers both ways to publish', async () => {
  const name = local('meetup:pythonsd');
  const response = await h.get(`/calendar/${name}/claim`);
  const html = await response.text();
  assert.equal(response.status, 200);
  scriptedPage(response, html);
  assert.match(html, /<h1>Claim San Diego Python Users Group<\/h1>/);
  assert.match(html, new RegExp(`<form[^>]+data-claim="/api/1.0/calendars/${name}/claim"`));
  assert.match(html, /<button type="button" data-sign-in>Sign in with your nostr key<\/button>/);
  assert.match(html, /<input type="radio" name="mode" value="own"/);
  assert.match(html, /<input type="radio" name="mode" value="delegated"/);
  assert.match(html, /name="bunker"[^>]*placeholder="bunker:\/\/…"/);
  assert.match(html, /kinds 31922, 31923, 31924 and deletions/);
  assert.match(html, /Meetup®/, 'where to place the token');
  assert.match(html, /<noscript>/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the script signs each request with NIP-98 and posts it to the site', async () => {
  const response = await h.get('/claim.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/javascript; charset=utf-8/);
  const js = await response.text();
  assert.match(js, /window\.nostr/);
  assert.match(js, /kind: 27235/);
  assert.match(js, /\['payload', await sha256\(text\)\]/);
  assert.match(js, /Authorization: `Nostr \$\{/);
  assert.ok(!/https?:\/\//.test(js), 'the script talks to no other site');
  assert.ok(!/innerHTML/.test(js), 'it writes text, never markup');
});

test('a calendar its organizer publishes says so, links their key, and offers its organizer the signer', async () => {
  const d = 'luma:cal-f6iLyfD3TN5qUO2';
  const owner = 'a0'.repeat(32);
  h.dir.setOwnership(d, { mode: 'delegated', owner, claimedAt: NOW, nativeCalendar: `31924:${owner}:${d}` });
  try {
    const html = await (await h.get(`/calendar/${local(d)}`)).text();
    assert.match(html, /Published by Event Index as its organizer, through a signer they connected/);
    assert.ok(html.includes(npubEncode(owner).slice(0, 12)));
    assert.ok(!/Claim this calendar/.test(html));
    assert.match(html, new RegExp(`href="/calendar/${local(d)}/claim">Manage how it is published</a>`));
    const manage = await h.get(`/calendar/${local(d)}/claim`);
    const page = await manage.text();
    scriptedPage(manage, page);
    assert.match(page, new RegExp(`data-signer="/api/1.0/calendars/${local(d)}/signer"`));
    assert.match(page, /<button type="button" data-disconnect>Disconnect the signer<\/button>/);
    h.dir.setOwnership(d, { mode: 'own', owner, claimedAt: NOW, nativeCalendar: null });
    const own = await (await h.get(`/calendar/${local(d)}`)).text();
    assert.match(own, /Published by its organizer from their own nostr key/);
    assert.match(await (await h.get(`/calendar/${local(d)}/claim`)).text(), /<button type="submit">Connect a signer<\/button>/);
  } finally {
    h.dir.setOwnership(d, { mode: 'mirrored', owner: null, claimedAt: null, nativeCalendar: null });
  }
});

test('a native calendar\'s page names its organizer\'s key and has no feed', async () => {
  const html = await (await h.get(`/calendar/${local(h.native!.d)}`)).text();
  assert.match(html, /<h1>Lakeside Bitcoin Club<\/h1>/);
  assert.match(html, /Published on nostr by its organizer/);
  assert.ok(!/>Feed</.test(html));
  assert.equal((html.match(/<li class="event">/g) ?? []).length, 2);
  assert.ok(!/Claim this calendar/.test(html));
  assert.match(html, new RegExp(`href="/calendar/${local(h.native!.d)}/claim">Manage this calendar</a>`));
});

test('its organizer can remove it at once from its manage page, signing with its key', async () => {
  const response = await h.get(`/calendar/${local(h.native!.d)}/claim`);
  const html = await response.text();
  scriptedPage(response, html);
  assert.match(html, new RegExp(`data-remove="/api/1.0/calendars/${local(h.native!.d)}/remove-request"`));
  assert.match(html, /<button type="button" data-remove-now>Remove this calendar now<\/button>/);
  const js = await (await h.get('/claim.js')).text();
  assert.match(js, /data-remove-now/);
});

test('the page to add a calendar by its nostr key', async () => {
  const response = await h.get('/add/nostr');
  const html = await response.text();
  assert.equal(response.status, 200);
  scriptedPage(response, html);
  assert.match(html, /<form[^>]+data-native="\/api\/1\.0\/calendars\/native"/);
  assert.match(html, /<select[^>]*name="city"[^>]*>[\s\S]*<option value="chicago">Chicago<\/option>/);
  assert.match(html, /The index signs nothing for it/);
  assert.match(html, /lists it on its own/);
  assert.match(html, /<button type="submit">List it, or save its city<\/button>/);
  const home = await (await h.get('/')).text();
  assert.match(home, /<a href="\/add\/nostr">Add it by its key<\/a>/);
});

test('a claim for an unknown or removed calendar is a 404 or a plain page', async () => {
  assert.equal((await h.get('/calendar/no-such-calendar/claim')).status, 404);
});
