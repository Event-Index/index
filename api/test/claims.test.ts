// Organizers acting with their own nostr key: filing a calendar they publish
// on nostr, claiming a calendar the index mirrors, and, once it is theirs,
// connecting or disconnecting the signer the index publishes through. Every
// request is signed for itself (NIP-98), as a browser extension signs it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { harness, NATIVE_RELAY, type Harness } from './harness.ts';
import { NOW } from '../../indexer/test/helpers.ts';

let h: Harness;
before(async () => { h = await harness({ native: true }); });
after(() => h.close());

const API = '/api/1.0';
const organizerKey = generateSecretKey();
const organizer = getPublicKey(organizerKey);
const local = (d: string) => h.dir.get(d)!.localName;

// A request signed with NIP-98 for its URL, method and body. The clock moves
// a second each time, as the same request signed in the same second is the
// same proof, which is used once.
async function signed(path: string, body: unknown, key = organizerKey, options: { url?: string; at?: number; direct?: boolean } = {}) {
  h.clock.now += 1;
  const text = JSON.stringify(body);
  const event = finalizeEvent({
    kind: 27235, content: '', created_at: options.at ?? h.clock.now,
    tags: [['u', options.url ?? `https://api.eventindex.space${path}`], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]],
  }, key);
  // Each from an address of its own, below the hourly limit.
  const proxied: Record<string, string> = options.direct ? {} : { 'x-real-ip': `203.0.113.${(ip += 1)}` };
  const response = await h.post(path, text, { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json', ...proxied });
  return { status: response.status, body: await response.json() as any };
}
let ip = 0;

test('a request without a proof of its key is refused', async () => {
  const path = `${API}/calendars/${local('meetup:pythonsd')}/claim`;
  const unsigned = await h.post(path, { mode: 'own' });
  assert.equal(unsigned.status, 401);
  assert.equal(((await unsigned.json()) as any).error, 'unauthorized');
  const stale = await signed(path, { mode: 'own' }, organizerKey, { at: h.clock.now - 600 });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.reason, 'expired');
  const elsewhere = await signed(path, { mode: 'own' }, organizerKey, { url: 'https://example.org/claim' });
  assert.equal(elsewhere.body.reason, 'wrong-url');
});

test('a native calendar is filed by its key for review, with what was found under it', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const sign = (kind: number, tags: string[][], content = '') => finalizeEvent({ kind, tags, content, created_at: NOW - 60 }, key);
  h.relay.get(NATIVE_RELAY)!.push(
    sign(0, [], JSON.stringify({ name: 'Riverside Chess Club' })),
    sign(31923, [['d', 'nov'], ['title', 'November open'], ['start', String(NOW + 20 * 86400)]]),
  );
  const filed = await signed(`${API}/calendars/native`, { city: 'chicago' }, key);
  assert.equal(filed.status, 202);
  assert.equal(filed.body.status, 'queued');
  assert.equal(filed.body.d, `nostr:${pubkey}`);
  assert.equal(filed.body.name, 'Riverside Chess Club');
  assert.equal(filed.body.events, 1);
  const submission = h.queues.submission(filed.body.submission)!;
  assert.deepEqual([submission.source, submission.feedUrl, submission.city], ['nostr', '', 'chicago']);
  assert.equal((await signed(`${API}/calendars/native`, {}, key)).body.status, 'already-queued');
});

test('a key with no calendar events, or one already listed, is not filed', async () => {
  const empty = await signed(`${API}/calendars/native`, {}, generateSecretKey());
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error, 'no-events');
  const native = h.native!;
  const listed = await signed(`${API}/calendars/native`, {}, native.key);
  assert.equal(listed.status, 409);
  assert.equal(listed.body.error, 'already-listed');
  assert.equal(listed.body.local_name, local(native.d));
  assert.equal((await signed(`${API}/calendars/native`, { city: 'atlantis' }, generateSecretKey())).status, 400);
});

test('a claim records the organizer\'s key and mode, and gives a token to place in the calendar', async () => {
  const name = local('meetup:pythonsd');
  const claimed = await signed(`${API}/calendars/${name}/claim`, { mode: 'own' });
  assert.equal(claimed.status, 202);
  assert.equal(claimed.body.status, 'received');
  assert.match(claimed.body.token, /^eventindex-claim-[a-z2-7]{10}$/);
  assert.match(claimed.body.instructions, /Meetup®/);
  const claim = h.queues.claim(claimed.body.claim)!;
  assert.deepEqual([claim.d, claim.pubkey, claim.kind, claim.mode, claim.status, claim.signer], ['meetup:pythonsd', organizer, 'claim', 'own', 'pending', null]);
});

test('a proof is used once', async () => {
  const path = `${API}/calendars/${local('meetup:pythonsd')}/claim`;
  const text = JSON.stringify({ mode: 'own' });
  h.clock.now += 1;
  const event = finalizeEvent({ kind: 27235, content: '', created_at: h.clock.now,
    tags: [['u', `https://api.eventindex.space${path}`], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]] }, organizerKey);
  const headers = { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' };
  assert.equal((await h.post(path, text, headers)).status, 202);
  const again = await h.post(path, text, headers);
  assert.equal(again.status, 401);
  assert.equal(((await again.json()) as any).reason, 'used');
});

test('a claim to be published as its organizer carries their signer, sealed for the poll service alone', async () => {
  const bunker = `bunker://${'ef'.repeat(32)}?relay=wss%3A%2F%2Fbunker.example.org&secret=one-time`;
  const claimed = await signed(`${API}/calendars/${local('luma:cal-BvuRd9eaZnDGBwy')}/claim`, { mode: 'delegated', bunker });
  assert.equal(claimed.status, 202);
  const claim = h.queues.claim(claimed.body.claim)!;
  assert.equal(claim.mode, 'delegated');
  assert.ok(claim.signer && !claim.signer.includes('bunker://') && !claim.signer.includes('one-time'));
  const bad = await signed(`${API}/calendars/${local('luma:cal-BvuRd9eaZnDGBwy')}/claim`, { mode: 'delegated', bunker: 'https://example.org' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid-signer');
  assert.equal((await signed(`${API}/calendars/${local('luma:cal-BvuRd9eaZnDGBwy')}/claim`, { mode: 'everything' })).body.error, 'invalid-mode');
});

test('NIP-05 on the calendar\'s own domain verifies a claim', async () => {
  const d = h.dir.list().find((e) => e.source === 'google')!.d;
  h.dir.setMeta(d, { name: null, description: null, url: 'https://www.sig-cli.example.org/calendar', image: null });
  const claimed = await signed(`${API}/calendars/${local(d)}/claim`, { mode: 'own' });
  assert.deepEqual(claimed.body.nip05_domains, ['sig-cli.example.org']);
  const path = `${API}/calendars/${local(d)}/claim/${claimed.body.claim}/nip05`;
  h.feeds.set('https://sig-cli.example.org/.well-known/nostr.json?name=events', { status: 'ok', text: JSON.stringify({ names: { events: 'ab'.repeat(32) } }), etag: null, lastModified: null, finalUrl: '' });
  const wrongKey = await signed(path, { nip05: 'events@sig-cli.example.org' });
  assert.equal(wrongKey.status, 422);
  assert.equal(wrongKey.body.error, 'nip05-mismatch');
  const wrongDomain = await signed(path, { nip05: 'events@elsewhere.example.org' });
  assert.equal(wrongDomain.body.error, 'nip05-domain');
  h.feeds.set('https://sig-cli.example.org/.well-known/nostr.json?name=events', { status: 'ok', text: JSON.stringify({ names: { events: organizer } }), etag: null, lastModified: null, finalUrl: '' });
  const ok = await signed(path, { nip05: 'events@sig-cli.example.org' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'verified');
  assert.deepEqual([h.queues.claim(claimed.body.claim)!.verifiedBy, h.queues.claim(claimed.body.claim)!.nip05], ['nip05', 'events@sig-cli.example.org']);
  const stranger = await signed(path, { nip05: 'events@sig-cli.example.org' }, generateSecretKey());
  assert.equal(stranger.status, 403);
});

test('a platform\'s own domain is never the calendar\'s', async () => {
  const claimed = await signed(`${API}/calendars/${local('meetup:pythonsd')}/claim`, { mode: 'own' });
  assert.deepEqual(claimed.body.nip05_domains, []);
});

test('a calendar already published by its organizer cannot be claimed again; its owner manages its signer', async () => {
  const d = 'mobilizon:mobilizon.fr/@lyontechhub';
  h.dir.setOwnership(d, { mode: 'delegated', owner: organizer, claimedAt: NOW, nativeCalendar: `31924:${organizer}:${d}` });
  const again = await signed(`${API}/calendars/${local(d)}/claim`, { mode: 'own' }, generateSecretKey());
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already-claimed');
  const notOwner = await signed(`${API}/calendars/${local(d)}/signer`, { action: 'disconnect' }, generateSecretKey());
  assert.equal(notOwner.status, 403);
  const disconnect = await signed(`${API}/calendars/${local(d)}/signer`, { action: 'disconnect' });
  assert.equal(disconnect.status, 202);
  const request = h.queues.claim(disconnect.body.request)!;
  assert.deepEqual([request.kind, request.status, request.pubkey], ['disconnect', 'approved', organizer]);
  const connect = await signed(`${API}/calendars/${local(d)}/signer`, { action: 'connect', bunker: `bunker://${'ef'.repeat(32)}?relay=wss%3A%2F%2Fbunker.example.org` });
  assert.equal(connect.status, 202);
  assert.equal(h.queues.claim(connect.body.request)!.kind, 'connect');
  h.dir.setOwnership(d, { mode: 'mirrored', owner: null, claimedAt: null, nativeCalendar: null });
});

test('a proof may name the address the request was made to on this machine, for running the site locally', async () => {
  const path = `${API}/calendars/${local('meetup:pythonsd')}/claim`;
  const local1 = await signed(path, { mode: 'own' }, generateSecretKey(), { url: `${h.base}${path}`, direct: true });
  assert.equal(local1.status, 202);
  const proxied = await signed(path, { mode: 'own' }, generateSecretKey(), { url: `${h.base}${path}` });
  assert.equal(proxied.body.reason, 'wrong-url', 'not for a request that came through the proxy');
  const spoofed = await signed(path, { mode: 'own' }, generateSecretKey(), { url: `http://evil.example${path}` });
  assert.equal(spoofed.body.reason, 'wrong-url');
});

test('a key whose claimed calendar was removed can still file its own; one that publishes a calendar itself cannot claim another', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const d = 'google:calendar@kubernetes.io';
  h.dir.setOwnership(d, { mode: 'own', owner: pubkey, claimedAt: NOW, nativeCalendar: null });
  const blocked = await signed(`${API}/calendars/${local('meetup:pythonsd')}/claim`, { mode: 'delegated', bunker: `bunker://${'ef'.repeat(32)}?relay=wss%3A%2F%2Fb.example.org` }, key);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'already-owner');
  const raw = h.db.raw;
  raw.prepare('UPDATE directory SET removed = ? WHERE d = ?').run('organizer request', d);
  h.relay.get(NATIVE_RELAY)!.push(finalizeEvent({ kind: 31923, tags: [['d', 'x'], ['title', 'Open night'], ['start', String(NOW + 86400)]], content: '', created_at: NOW }, key));
  const filed = await signed(`${API}/calendars/native`, {}, key);
  assert.equal(filed.status, 202);
  raw.prepare('UPDATE directory SET removed = NULL WHERE d = ?').run(d);
  h.dir.setOwnership(d, { mode: 'mirrored', owner: null, claimedAt: null, nativeCalendar: null });
});
