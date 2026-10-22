// The guard on the two forms anyone can send without a key, and on the
// unsigned remove requests: what a person sending the form gets through, what
// a form-filling program does not, and that an organizer with proof is never
// held back.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { harness, type Harness } from './harness.ts';
import { readFixture, NOW } from '../../indexer/test/helpers.ts';
import { FORM_MIN_SECONDS } from '../src/guard.ts';

let h: Harness;
before(async () => { h = await harness(); });
after(() => h.close());

const API = '/api/1.0';
const DAY = 86400;
const local = (d: string) => h.dir.get(d)!.localName;
let ip = 0;
const from = () => ({ 'x-real-ip': `192.0.2.${(ip += 1)}` });
const SPAM = 'Submit eventindex.space in Google\'s Search Index today at siteindex.example';

// The form posting to `action` on a page, and its token.
function formIn(html: string, action: string): { html: string; token: string } {
  const form = new RegExp(`<form[^>]+action="${action}"[^>]*>[\\s\\S]*?</form>`).exec(html)?.[0];
  assert.ok(form, `a form to ${action}`);
  const token = /<input type="hidden" name="form" value="([^"]+)">/.exec(form)?.[1];
  assert.ok(token, 'with its token');
  return { html: form, token };
}
const send = (action: string, fields: Record<string, string>, headers = from()) => h.post(action, new URLSearchParams(fields).toString(), headers);
const pending = (d: string) => h.queues.removals('pending').filter((r) => r.d === d);

test('the remove form carries a signed token and a field people leave empty; sent as a person sends it, it is received', async () => {
  const name = local('meetup:pythonsd');
  const { html, token } = formIn(await (await h.get(`/calendar/${name}`)).text(), `/calendar/${name}/remove`);
  assert.match(html, /<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="topic" tabindex="-1" autocomplete="off"><\/label><\/div>/);
  h.clock.now += FORM_MIN_SECONDS + 2;
  const response = await send(`/calendar/${name}/remove`, { form: token, topic: '', message: 'We run this group.' });
  assert.equal(response.status, 202);
  assert.match(await response.text(), /Request received/);
  assert.equal(pending('meetup:pythonsd').length, 1);
});

test('a remove form sent without its page, too fast, twice or with the hidden field filled in is not received, is logged, and comes back fresh', async () => {
  const d = 'luma:cal-BvuRd9eaZnDGBwy';
  const name = local(d);
  const action = `/calendar/${name}/remove`;
  const open = async () => formIn(await (await h.get(`/calendar/${name}`)).text(), action).token;
  const before = pending(d).length;
  const logs = h.logs.length;

  const bare = await send(action, { message: SPAM });
  assert.equal(bare.status, 400);
  const page = await bare.text();
  assert.match(page, /Request not sent/);
  assert.ok(formIn(page, action).token, 'with a fresh form to send again');

  assert.equal((await send(action, { form: await open(), message: 'hello' })).status, 400, 'too fast');

  const once = await open();
  h.clock.now += FORM_MIN_SECONDS + 2;
  assert.equal((await send(action, { form: once, message: 'first' })).status, 202);
  assert.equal((await send(action, { form: once, message: 'second' })).status, 400, 'the same form again');

  const bait = await open();
  h.clock.now += FORM_MIN_SECONDS + 2;
  assert.equal((await send(action, { form: bait, topic: 'https://spam.example', message: 'hello' })).status, 400);

  assert.equal(pending(d).length, before + 1, 'only the one sent as a person sends it');
  assert.deepEqual(h.logs.slice(logs).filter((l) => l.startsWith('blocked')), [
    `blocked remove request for ${name}: no-form-token`,
    `blocked remove request for ${name}: too-fast`,
    `blocked remove request for ${name}: form-reused`,
    `blocked remove request for ${name}: honeypot`,
  ]);
});

test('the submit form is guarded the same way', async () => {
  const url = 'https://example.org/guarded.ics';
  h.feeds.set(url, { status: 'ok', text: readFixture('synthetic/rich.ics'), etag: null, lastModified: null, finalUrl: url });
  const { token } = formIn(await (await h.get('/')).text(), '/submit');
  const bare = await send('/submit', { url });
  assert.equal(bare.status, 400);
  assert.ok(formIn(await bare.text(), '/submit').token, 'with a fresh form to send again');
  assert.ok(h.logs.includes('blocked submission: no-form-token'));
  h.clock.now += FORM_MIN_SECONDS + 2;
  const ok = await send('/submit', { form: token, topic: '', url });
  assert.equal(ok.status, 202);
  assert.match(await ok.text(), /Rich Calendar/);
});

test('remove requests for one calendar are limited per hour, from whatever address they come', async () => {
  const name = local('google:calendar@kubernetes.io');
  const codes: number[] = [];
  for (let i = 0; i < 4; i += 1) codes.push((await h.post(`${API}/calendars/${name}/remove-request`, { message: `note ${i}` }, from())).status);
  assert.deepEqual(codes, [202, 202, 202, 429]);
  assert.ok(h.logs.includes(`blocked remove request for ${name}: rate-limited`));
  h.clock.now += 3601;
  assert.equal((await h.post(`${API}/calendars/${name}/remove-request`, {}, from())).status, 202, 'an hour later');
});

test('a long message sent again for the same calendar gets its request back; for another calendar it is refused', async () => {
  const a = local('luma:cal-f6iLyfD3TN5qUO2');
  const b = local('mobilizon:mobilizon.fr/@lyontechhub');
  const first = await (await h.post(`${API}/calendars/${a}/remove-request`, { message: SPAM }, from())).json() as any;
  const again = await h.post(`${API}/calendars/${a}/remove-request`, { message: `  ${SPAM.toUpperCase()}` }, from());
  assert.equal(again.status, 202);
  const body = await again.json() as any;
  assert.deepEqual([body.request, body.token], [first.request, first.token], 'the same request, not another');
  assert.equal(h.queues.removals('pending').filter((r) => r.message === SPAM).length, 1);
  const elsewhere = await h.post(`${API}/calendars/${b}/remove-request`, { message: SPAM }, from());
  assert.equal(elsewhere.status, 409);
  assert.equal(((await elsewhere.json()) as any).error, 'duplicate-message');
  assert.ok(h.logs.includes(`blocked remove request for ${b}: duplicate`));
  // A short message is common, and may be sent for any calendar.
  for (const name of [a, b]) assert.equal((await h.post(`${API}/calendars/${name}/remove-request`, { message: 'Please remove us.' }, from())).status, 202);
});

test('a request signed with the calendar\'s own key is never held back by the guard', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  h.dir.add({ d: `nostr:${pubkey}`, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: 'Harbor', description: null, image: null,
    location: null, g: null, foundVia: 'ingest', addedAt: NOW, mode: 'own', owner: pubkey });
  const name = local(`nostr:${pubkey}`);
  const path = `${API}/calendars/${name}/remove-request`;
  for (let i = 0; i < 4; i += 1) await h.post(path, { message: `unsigned ${i}` }, from());
  assert.equal((await h.post(path, {}, from())).status, 429, 'unsigned requests for it are spent for the hour');
  h.clock.now += 1;
  const text = '{}';
  const proof = finalizeEvent({ kind: 27235, content: '', created_at: h.clock.now,
    tags: [['u', `https://api.eventindex.space${path}`], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]] }, key);
  const signed = await h.post(path, text, { authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`, 'content-type': 'application/json', ...from() });
  assert.equal(signed.status, 202);
  assert.equal(((await signed.json()) as any).status, 'approved');
});

test('a request whose token is not seen in two weeks expires; one whose token was seen waits for review', async () => {
  const d = 'meetup:pythonsd';
  const unseen = await (await h.post(`${API}/calendars/${local(d)}/remove-request`, { message: 'unseen' }, from())).json() as any;
  const seen = await (await h.post(`${API}/calendars/${local(d)}/remove-request`, { message: 'seen' }, from())).json() as any;
  h.queues.markVerified(seen.request, h.clock.now);
  h.clock.now += 13 * DAY;
  await h.indexer.tick();
  assert.equal(h.queues.removal(unseen.request)!.status, 'pending', 'still waiting after 13 days');
  h.clock.now += 2 * DAY;
  await h.indexer.tick();
  assert.equal(h.queues.removal(unseen.request)!.status, 'expired');
  assert.equal(h.queues.removal(seen.request)!.status, 'pending');
});
