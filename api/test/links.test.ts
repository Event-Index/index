// Submitting whatever link people paste: the index says in plain words what
// it found, or why it cannot use it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { harness, NATIVE_RELAY, type Harness } from './harness.ts';
import { readFixture, readPage, NOW } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness({ native: true }); });
after(() => h.close());

const API = '/api/1.0';
let ip = 0;
const from = () => ({ 'x-real-ip': `192.0.2.${(ip += 1)}` });
const ok = (text: string, url: string) => ({ status: 'ok' as const, text, etag: null, lastModified: null, finalUrl: url });

async function submit(url: string) {
  const response = await h.post(`${API}/feeds/add`, { url }, from());
  return { status: response.status, body: await response.json() as any };
}

// These feeds are safe to index, so they are filed at once (201).
test('a Meetup group\'s events page is found as the group', async () => {
  const feed = 'https://www.meetup.com/ribitcoiners/events/ical/';
  h.feeds.set(feed, ok(readFixture('meetup-pythonsd.ics').replace(/San Diego Python Users Group/g, 'Rhode Island Bitcoin Meetup Group'), feed));
  const { status, body } = await submit('https://www.meetup.com/ribitcoiners/events/');
  assert.equal(status, 201);
  assert.equal(body.status, 'approved');
  assert.equal(body.d, 'meetup:ribitcoiners');
  assert.equal(body.found, 'Found the Meetup group "Rhode Island Bitcoin Meetup Group".');
});

test('a Luma event\'s page is found as its calendar', async () => {
  h.feeds.set('https://luma.com/propellerinc', ok(readPage('luma-calendar-page.html'), 'https://luma.com/propellerinc'));
  const feed = 'https://api.luma.com/ics/get?entity=calendar&id=cal-ntaub36zjjTvcnl';
  h.feeds.set(feed, ok(readFixture('luma-calendar-craftnook.ics').replace(/welcome to the craftnook/g, 'Propeller'), feed));
  const { status, body } = await submit('https://lu.ma/propellerinc');
  assert.equal(status, 201);
  assert.equal(body.d, 'luma:cal-ntaub36zjjTvcnl');
  assert.equal(body.found, 'Found the Luma calendar "Propeller".');
});

test('a nostr address is found as a publisher and listed at once', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  h.relay.get(NATIVE_RELAY)!.push(
    finalizeEvent({ kind: 0, tags: [], content: JSON.stringify({ name: 'Harbor Chess Club' }), created_at: NOW }, key),
    finalizeEvent({ kind: 31923, tags: [['d', 'x'], ['title', 'Open night'], ['start', String(NOW + 86400)]], content: '', created_at: NOW }, key),
  );
  const { status, body } = await submit(npubEncode(pubkey));
  assert.equal(status, 201);
  assert.equal(body.status, 'listed');
  assert.equal(body.found, 'Found the nostr calendar "Harbor Chess Club", with 1 event.');
  const entry = h.dir.get(`nostr:${pubkey}`)!;
  assert.deepEqual([entry.mode, entry.owner, entry.foundVia], ['own', pubkey, 'submission']);
  const again = await submit(`nostr:${npubEncode(pubkey)}`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already-listed');
});

test('a link that cannot be used is refused in plain words', async () => {
  const meetup = await submit('https://www.meetup.com/find/?keywords=bitcoin');
  assert.deepEqual([meetup.status, meetup.body.error], [400, 'meetup-page']);
  assert.match(meetup.body.message, /not a group's/);
  const nothing = await submit('this is not a link');
  assert.deepEqual([nothing.status, nothing.body.error], [400, 'invalid-url']);
  const silent = await submit(npubEncode(getPublicKey(generateSecretKey())));
  assert.deepEqual([silent.status, silent.body.error], [422, 'no-events']);
});

test('the submit form says what to paste, and answers with what was found', async () => {
  const home = await (await h.get('/')).text();
  assert.match(home, /placeholder="Paste a link to the calendar, group or event"/);
  const feed = 'https://www.meetup.com/sdbitcoiners/events/ical/';
  h.feeds.set(feed, ok(readFixture('meetup-pythonsd.ics').replace(/San Diego Python Users Group/g, 'San Diego Bitcoiners'), feed));
  const response = await h.sendForm('/', '/submit', { url: 'https://www.meetup.com/sdbitcoiners/events/312775793/' }, from());
  const html = await response.text();
  assert.equal(response.status, 201);
  assert.match(html, /<h1>Added<\/h1>/);
  assert.match(html, /Found the Meetup group &quot;San Diego Bitcoiners&quot;\./);
});

test('a nostr address with only past events is kept without a listing, and left out of the public lists', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  h.relay.get(NATIVE_RELAY)!.push(
    finalizeEvent({ kind: 0, tags: [], content: JSON.stringify({ name: 'Old Chess Club' }), created_at: NOW }, key),
    finalizeEvent({ kind: 31923, tags: [['d', 'y'], ['title', 'Last open night'], ['start', String(NOW - 86400)]], content: '', created_at: NOW }, key),
  );
  const { status, body } = await submit(npubEncode(pubkey));
  assert.equal(status, 202);
  assert.equal(body.status, 'kept');
  assert.equal(body.found, 'Found the nostr calendar "Old Chess Club", with 1 event, none upcoming.');
  assert.match(body.message, /lists it once it has an upcoming event/);
  const entry = h.dir.get(`nostr:${pubkey}`)!;
  assert.equal(entry.listed, false);
  const again = await submit(npubEncode(pubkey));
  assert.deepEqual([again.status, again.body.status], [202, 'kept']);
  assert.doesNotMatch(await (await h.get('/calendars')).text(), /Old Chess Club/);
  const search = await (await h.get(`${API}/search/calendars/byterm?q=old%20chess`)).json() as { count: number };
  assert.equal(search.count, 0);
  const one = await h.get(`${API}/calendars/byslug/${entry.localName}`);
  assert.equal(one.status, 200, 'it is still served by its own address');
  const view = await one.json() as { eventindex: { listed: boolean; address: string | null } };
  assert.deepEqual([view.eventindex.listed, view.eventindex.address], [false, null], 'it has no directory entry');
  const page = await h.sendForm('/', '/submit', { url: npubEncode(pubkey) }, from());
  assert.equal(page.status, 202);
  assert.match(await page.text(), /<h1>Kept<\/h1>/);
});
