// Claiming a mirrored calendar with the organizer's own key, as the poll
// service carries it out: "I publish myself" (the index reads the
// organizer's events instead) and "publish for me, as me" (the index signs
// with the organizer's key, through their remote signer). Either way the
// calendar key retires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { naddrEncode, npubEncode } from 'nostr-tools/nip19';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import { sealFor } from '../src/claim/seal.ts';
import type { RemoteSigners, RemoteSession } from '../src/claim/signer.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const D = 'meetup:pythonsd';
const OWN = 'ws://own.test';
const HOME = 'wss://home.test';
const MONTHLY = nostrD('event_312775793@meetup.com');
const STUDY = nostrD('event_316721984@meetup.com');

// A remote signer per bunker key, signing as the key it holds.
function fakeSigners(holds: Map<string, Uint8Array>) {
  const asked: number[] = [];
  const state = { down: false, pairs: 0 };
  const session = (sk: Uint8Array): RemoteSession => ({
    pubkey: getPublicKey(sk),
    async sign(template) {
      if (state.down) throw new Error('the signer did not answer');
      asked.push(template.kind);
      return finalizeEvent(template, sk);
    },
    async close() {},
  });
  const signers: RemoteSigners = {
    async pair(pointer) {
      state.pairs += 1;
      const sk = holds.get(pointer.pubkey);
      if (!sk || state.down) throw new Error('the signer did not answer');
      return { connection: { clientSecret: 'cc'.repeat(32), bunker: pointer }, session: session(sk) };
    },
    async open(connection) {
      const sk = holds.get(connection.bunker.pubkey);
      if (!sk || state.down) throw new Error('the signer did not answer');
      return session(sk);
    },
  };
  return { signers, asked, state };
}

function claimHarness(options: { held?: Record<string, VerifiedEvent[]>; holds?: Map<string, Uint8Array>; strictRelays?: boolean; host?: boolean; batch?: number; etag?: boolean } = {}) {
  // Feed texts by URL, in place of the fixture.
  const texts: Record<string, string> = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'claim-'));
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const events = eventStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const held = options.held ?? {};
  held[OWN] ??= [];
  const sent: Array<{ audience: Audience | 'home'; event: VerifiedEvent; relays?: string[] }> = [];
  const fetched: string[] = [];
  const rsvps = new Set<string>();
  const clock = { now: NOW };
  // How many publishes to the index's relay fail before it takes them again.
  const outage = { own: 0 };
  const fake = fakeSigners(options.holds ?? new Map());
  const settings = loadSettings({ EVENTINDEX_DATA_DIR: dataDir, EVENTINDEX_RELAY_URL: OWN, EVENTINDEX_GENERAL_RELAYS: 'wss://general.test', EVENTINDEX_PROFILE_RELAYS: 'none',
    ...(options.host ? { EVENTINDEX_RELAY_HOSTS_CLAIMANTS: '1' } : {}) });
  const indexer = createIndexer({
    db, dir, queues, events, vault, indexKey, settings,
    now: () => clock.now,
    fetch: async (url, validators): Promise<FetchResult> => {
      fetched.push(url);
      const text = texts[url] ?? readFixture('meetup-pythonsd.ics');
      // A feed with an ETag answers 304 while it has not changed.
      const etag = `"${text.length}"`;
      if (options.etag && validators.etag === etag) return { status: 'not-modified' };
      return { status: 'ok', text, etag: options.etag ? etag : null, lastModified: null, finalUrl: url };
    },
    publisher: {
      publish: async (list, audience) => {
        if (audience === 'own' && outage.own > 0) {
          outage.own -= 1;
          throw new Error('the relay did not answer');
        }
        sent.push(...list.map((event) => ({ audience, event })));
        if (audience === 'own') held[OWN]!.push(...list);
      },
      publishTo: async (list, relays) => {
        sent.push(...list.map((event) => ({ audience: 'home' as const, event, relays })));
        for (const relay of relays) (held[relay] ??= []).push(...list);
      },
      rsvps: async () => rsvps,
      close: () => {},
    },
    reader: {
      async query(urls: string[], filter: Filter) {
        const answered = urls.filter((u) => held[u]);
        return { answered, found: answered.flatMap((relay) => held[relay]!.filter((e) => matchFilter(filter, e)).map((event) => ({ event, relay }))) };
      },
    },
    ...(options.strictRelays ? {} : { relayAllowed: async () => true }),
    signers: fake.signers,
    ...(options.batch ? { signBatch: options.batch } : {}),
    log: () => {},
  });
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
    location: 'San Diego, US', g: '9mud', foundVia: 'maintainer', addedAt: NOW - 86400 });
  const tickAt = async (at: number) => {
    clock.now = at;
    return indexer.tick();
  };
  const by = (pubkey: string, from = 0) => sent.slice(from).filter((s) => s.event.pubkey === pubkey);
  const approve = (claim: { id: number }) => {
    queues.markClaimVerified(claim.id, 'token', null, clock.now);
    queues.resolveClaim(claim.id, 'approved', clock.now);
  };
  return {
    db, dir, queues, events, vault, indexer, settings, sent, fetched, rsvps, clock, held, fake, dataDir, texts, outage, tickAt, by, approve,
    indexPubkey: getPublicKey(indexKey),
    allowlist: () => JSON.parse(readFileSync(join(dataDir, 'relay-allowlist.json'), 'utf8')) as { live: string[]; removed: string[]; hosted: string[] },
    close() { vault.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

const tag = (e: VerifiedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];

test('a claim\'s token found in the feed shows the organizer runs the calendar', async () => {
  const h = claimHarness();
  const mine = h.queues.requestClaim({ d: D, pubkey: 'a0'.repeat(32), mode: 'own', signer: null, at: NOW });
  const other = h.queues.requestClaim({ d: D, pubkey: 'b0'.repeat(32), mode: 'own', signer: null, at: NOW });
  h.texts[h.dir.get(D)!.feedUrl] = readFixture('meetup-pythonsd.ics').replace('BEGIN:VCALENDAR', `BEGIN:VCALENDAR\r\nX-WR-CALDESC:${mine.token}`);
  await h.tickAt(NOW);
  assert.deepEqual([h.queues.claim(mine.id)!.verifiedBy, h.queues.claim(mine.id)!.verifiedAt], ['token', NOW]);
  assert.equal(h.queues.claim(other.id)!.verifiedBy, null, 'another claim\'s token proves nothing for it');
  h.close();
});

test('"I publish myself": the calendar key withdraws its events, says where the calendar went, and is deleted', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const sign = (kind: number, tags: string[][], content = '') => finalizeEvent({ kind, tags, content, created_at: NOW }, organizerKey);
  const own = sign(31923, [['d', 'sdpy-nov'], ['title', 'SDPy Monthly Meetup'], ['start', '1792720800'], ['r', 'https://www.meetup.com/pythonsd/events/312775793/']]);
  const h = claimHarness({ held: { [OWN]: [sign(10002, [['r', HOME]])], [HOME]: [own] } });
  await h.tickAt(NOW);
  const key = h.dir.get(D)!.pubkey!;
  h.rsvps.add(`31923:${key}:${MONTHLY}`);
  h.rsvps.add(`31923:${key}:${STUDY}`);
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'own', signer: null, at: NOW });
  h.approve(claim);
  const before = h.sent.length;
  const report = await h.tickAt(NOW + 60);
  assert.deepEqual(report.failed, []);
  assert.equal(h.queues.claim(claim.id)!.status, 'done');

  const last = h.by(key, before).map((s) => s.event);
  const profile = JSON.parse(last.find((e) => e.kind === 0)!.content) as Record<string, string>;
  assert.equal(profile['about'], `This calendar now publishes as ${npubEncode(organizer)}.`);
  const cancelled = last.filter((e) => e.kind === 31923);
  assert.deepEqual(cancelled.map((e) => tag(e, 'd')).sort(), [MONTHLY, STUDY].sort(), 'events with RSVPs are kept, as cancelled');
  assert.ok(cancelled.every((e) => tag(e, 'title')!.startsWith('Cancelled: ')));
  const monthly = cancelled.find((e) => tag(e, 'd') === MONTHLY)!;
  assert.deepEqual(monthly.tags.find((t) => t[0] === 'q'), ['q', `31923:${organizer}:sdpy-nov`, HOME], 'a copy names the organizer\'s own event');
  assert.equal(cancelled.find((e) => tag(e, 'd') === STUDY)!.tags.find((t) => t[0] === 'q'), undefined);
  const deletions = last.filter((e) => e.kind === 5);
  assert.equal(deletions.length, 2, 'events without RSVPs are deleted');
  const calendar = last.find((e) => e.kind === 31924)!;
  assert.match(calendar.content, new RegExp(`now publishes as ${npubEncode(organizer)}`));
  assert.deepEqual(calendar.tags.filter((t) => t[0] === 'a').map((t) => t[1]!.split(':')[2]).sort(), [MONTHLY, STUDY].sort());

  assert.equal(h.vault.pubkeyFor(D), null, 'the calendar key is deleted');
  assert.ok(h.allowlist().removed.includes(key) && !h.allowlist().live.includes(key));
  const entry = h.dir.get(D)!;
  assert.deepEqual([entry.mode, entry.owner, entry.claimedAt], ['own', organizer, NOW + 60]);
  const listed = h.by(h.indexPubkey, before).filter((s) => s.event.kind === 39999).at(-1)!.event;
  assert.deepEqual(listed.tags.filter((t) => t[0] === 'p'), [['p', organizer], ['p', key]], 'the old key stays findable while its events are to come');
  assert.equal(tag(listed, 'source'), 'nostr');
  assert.deepEqual(h.events.byCalendar(D, NOW, NOW + 365 * 86400).map((r) => r.title), ['SDPy Monthly Meetup'], 'the organizer\'s own events are served');
  const oldRecord = h.db.record(h.db.recordsOf(D).find((r) => r.uid === 'event_312775793@meetup.com')!.id)!;
  assert.match(oldRecord.ics.replace(/\r\n /g, ''), /X-EVENTINDEX-CANONICAL:https:\/\/api\.eventindex\.space\/api\/1\.0\/events\/byid\/[a-z2-7]{32}/);
  const ownRecord = h.db.recordsOf(D).find((r) => r.uid === `31923:${organizer}:sdpy-nov`)!;
  assert.match(ownRecord.ics, /X-EVENTINDEX-CLAIMED:2026-10-15/, 'a claimed calendar\'s records say when it was claimed');

  const fetchedBefore = h.fetched.length;
  h.db.savePollState(D, { ...h.db.pollState(D), nextPollAt: 0 });
  await h.tickAt(NOW + 7 * 3600);
  assert.equal(h.fetched.length, fetchedBefore, 'the feed is no longer read');
  await h.tickAt(1792720800 + 60);
  const after = h.by(h.indexPubkey).filter((s) => s.event.kind === 39999).at(-1)!.event;
  assert.deepEqual(after.tags.filter((t) => t[0] === 'p'), [['p', organizer]], 'once its last event has started, the old key is dropped');
  h.close();
});

test('"publish for me, as me": the index connects to the organizer\'s signer and publishes the feed as them', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), held: { [OWN]: [finalizeEvent({ kind: 10002, tags: [['r', HOME]], content: '', created_at: NOW }, organizerKey)] } });
  await h.tickAt(NOW);
  const key = h.dir.get(D)!.pubkey!;
  const sealed = sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fbunker.test&secret=one-time`);
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealed, at: NOW });
  h.approve(claim);
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  assert.equal(h.queues.claim(claim.id)!.status, 'done');
  assert.equal(h.queues.claim(claim.id)!.signer, null, 'the sealed connection is not kept in index.db');
  const connection = h.vault.connection(D)!;
  assert.deepEqual([connection.owner, connection.bunker.pubkey, connection.bunker.relays], [organizer, bunker, ['wss://bunker.test']]);

  const theirs = h.by(organizer, before).map((s) => s.event);
  assert.deepEqual(theirs.map((e) => e.kind).sort(), [31923, 31923, 31923, 31923, 31924], 'no profile or relay list is written for them');
  assert.ok(theirs.every((e) => verifyEvent(e)));
  assert.ok(h.fake.asked.every((k) => [31922, 31923, 31924, 5].includes(k)));
  assert.ok(h.by(organizer, before).every((s) => s.audience === 'home' && s.relays!.includes(HOME)), 'their events go to their own relays');
  const monthly = theirs.find((e) => tag(e, 'd') === MONTHLY)!;
  assert.deepEqual(monthly.tags.find((t) => t[0] === 'p'), ['p', organizer, HOME, 'host']);
  const calendar = theirs.find((e) => e.kind === 31924)!;
  assert.equal(tag(calendar, 'd'), D, 'one calendar per claimed directory entry');

  const retiring = h.by(key, before).map((s) => s.event);
  assert.match(JSON.parse(retiring.find((e) => e.kind === 0)!.content).about, /now publishes as npub1/);
  const deleted = retiring.filter((e) => e.kind === 5);
  assert.equal(deleted.length, 4, 'the old copies, none with RSVPs, are deleted');
  assert.equal(h.vault.pubkeyFor(D), null);

  const entry = h.dir.get(D)!;
  assert.deepEqual([entry.mode, entry.owner, entry.nativeCalendar], ['delegated', organizer, `31924:${organizer}:${D}`]);
  const record = h.db.recordsOf(D).find((r) => r.uid === 'event_312775793@meetup.com')!;
  assert.match(record.ics, /X-EVENTINDEX-CLAIMED:2026-10-15/);
  assert.match(record.ics.replace(/\r\n /g, ''), new RegExp(`X-EVENTINDEX-NOSTR:${naddrEncode({ kind: 31923, pubkey: organizer, identifier: MONTHLY, relays: [HOME] })}`), 'the record names its event under the organizer\'s key');
  const listed = h.by(h.indexPubkey, before).filter((s) => s.event.kind === 39999).at(-1)!.event;
  assert.deepEqual(listed.tags.filter((t) => t[0] === 'p'), [['p', organizer]]);
  assert.equal(tag(listed, 'feed'), 'https://www.meetup.com/pythonsd/events/ical/');
  assert.equal(tag(listed, 'calendar'), `31924:${organizer}:${D}`);

  const settled = h.sent.length;
  h.db.savePollState(D, { ...h.db.pollState(D), nextPollAt: 0 });
  await h.tickAt(NOW + 120);
  assert.equal(h.by(organizer, settled).length, 0, 'unchanged events are not signed again');
  h.close();
});

test('an old copy with RSVPs names the event that replaces it, under the organizer\'s key', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]) });
  await h.tickAt(NOW);
  const key = h.dir.get(D)!.pubkey!;
  h.rsvps.add(`31923:${key}:${MONTHLY}`);
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fbunker.test`), at: NOW });
  h.approve(claim);
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  const copy = h.by(key, before).map((s) => s.event).find((e) => e.kind === 31923)!;
  assert.equal(tag(copy, 'd'), MONTHLY);
  assert.deepEqual(copy.tags.find((t) => t[0] === 'q'), ['q', `31923:${organizer}:${MONTHLY}`, 'wss://general.test']);
  h.close();
});

test('a signer that does not answer, or signs for another key, fails the claim and leaves the calendar as it was', async () => {
  const organizer = getPublicKey(generateSecretKey());
  const h = claimHarness({ holds: new Map([['cc'.repeat(32), generateSecretKey()]]) });
  await h.tickAt(NOW);
  const key = h.dir.get(D)!.pubkey!;
  const silent = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${'dd'.repeat(32)}?relay=wss%3A%2F%2Fb.test`), at: NOW });
  const other = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${'cc'.repeat(32)}?relay=wss%3A%2F%2Fb.test`), at: NOW });
  h.approve(silent);
  h.approve(other);
  await h.tickAt(NOW + 60);
  assert.deepEqual([h.queues.claim(silent.id)!.status, h.queues.claim(silent.id)!.note], ['failed', 'the signer did not answer']);
  assert.deepEqual([h.queues.claim(other.id)!.status, h.queues.claim(other.id)!.note], ['failed', 'the signer signs for another key']);
  assert.equal(h.dir.get(D)!.mode, 'mirrored');
  assert.equal(h.vault.pubkeyFor(D), key);
  assert.equal(h.vault.connection(D), null);
  h.close();
});

test('while the organizer\'s signer does not answer, the calendar\'s poll fails and nothing is signed for it', async () => {
  const organizerKey = generateSecretKey();
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]) });
  await h.tickAt(NOW);
  const claim = h.queues.requestClaim({ d: D, pubkey: getPublicKey(organizerKey), mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW });
  h.approve(claim);
  await h.tickAt(NOW + 60);
  h.fake.state.down = true;
  h.db.savePollState(D, { ...h.db.pollState(D), nextPollAt: 0 });
  h.texts[h.dir.get(D)!.feedUrl] = readFixture('meetup-pythonsd.ics').replace('SDPy Monthly Meetup', 'SDPy Monthly Meetup (moved)');
  const before = h.sent.length;
  const report = await h.tickAt(NOW + 7 * 3600);
  assert.ok(report.failed.includes(D));
  assert.equal(h.sent.slice(before).filter((s) => s.event.pubkey !== h.indexPubkey).length, 0);
  assert.equal(h.db.pollState(D).failures, 1);
  h.close();
});

test('the organizer disconnects their signer: the index forgets it and reads their own events; they can connect one again', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), held: { [OWN]: [finalizeEvent({ kind: 10002, tags: [['r', HOME]], content: '', created_at: NOW }, organizerKey)] } });
  await h.tickAt(NOW);
  h.approve(h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW }));
  await h.tickAt(NOW + 60);
  const off = h.queues.ownerRequest({ d: D, pubkey: organizer, kind: 'disconnect', signer: null, at: NOW + 70 });
  await h.tickAt(NOW + 120);
  assert.equal(h.queues.claim(off)!.status, 'done');
  assert.equal(h.vault.connection(D), null);
  assert.equal(h.dir.get(D)!.mode, 'own');
  assert.equal(h.events.byCalendar(D, NOW, NOW + 365 * 86400).length, 4, 'the events published as them are now read as theirs');

  const on = h.queues.ownerRequest({ d: D, pubkey: organizer, kind: 'connect', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW + 130 });
  await h.tickAt(NOW + 180);
  assert.equal(h.queues.claim(on)!.status, 'done');
  assert.equal(h.dir.get(D)!.mode, 'delegated');
  assert.equal(h.vault.connection(D)!.owner, organizer);
  h.close();
});

test('a signer on a relay the index will not connect to (not wss, or not public) is refused', async () => {
  const organizerKey = generateSecretKey();
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), strictRelays: true });
  await h.tickAt(NOW);
  const claim = h.queues.requestClaim({ d: D, pubkey: getPublicKey(organizerKey), mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=ws%3A%2F%2F127.0.0.1%3A7777`), at: NOW });
  h.approve(claim);
  await h.tickAt(NOW + 60);
  assert.deepEqual([h.queues.claim(claim.id)!.status, h.queues.claim(claim.id)!.note], ['failed', 'the signer\'s relays are not reachable by the index']);
  assert.equal(h.dir.get(D)!.mode, 'mirrored');
  h.close();
});

test('removing a calendar its organizer publishes forgets their signer and signs nothing', async () => {
  const organizerKey = generateSecretKey();
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]) });
  await h.tickAt(NOW);
  h.approve(h.queues.requestClaim({ d: D, pubkey: getPublicKey(organizerKey), mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW }));
  await h.tickAt(NOW + 60);
  const { id } = h.queues.requestRemoval({ d: D, message: null, at: NOW + 70 });
  h.queues.resolveRemoval(id, 'approved', NOW + 70);
  const before = h.sent.length;
  await h.tickAt(NOW + 120);
  assert.equal(h.dir.get(D)!.removed, 'organizer request');
  assert.equal(h.vault.connection(D), null);
  assert.ok(h.sent.slice(before).every((s) => s.event.pubkey === h.indexPubkey), 'the organizer\'s events are theirs; nothing is signed as them');
  h.close();
});

test('when the operator has the relay host claimants, an organizer the index publishes as is on its allowlist, and its events go there too', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), host: true });
  await h.tickAt(NOW);
  h.approve(h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW }));
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  assert.deepEqual(h.allowlist().hosted, [organizer]);
  const theirs = h.sent.slice(before).filter((s) => s.event.pubkey === organizer);
  assert.ok(theirs.some((s) => s.audience === 'own'), 'on the index\'s relay');
  assert.deepEqual(theirs.find((s) => s.event.kind === 31923)!.event.tags.find((t) => t[0] === 'p'), ['p', organizer, 'wss://relay.eventindex.space', 'host']);
  h.queues.ownerRequest({ d: D, pubkey: organizer, kind: 'disconnect', signer: null, at: NOW + 70 });
  await h.tickAt(NOW + 120);
  assert.deepEqual(h.allowlist().hosted, [], 'no longer once they publish themselves');
  h.close();
});

test('a poll signs at most a batch as the organizer, publishes it, and comes back soon for the rest', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), batch: 2 });
  await h.tickAt(NOW);
  h.approve(h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW }));
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  assert.equal(h.by(organizer, before).length, 2, 'the first batch goes out');
  assert.ok(h.db.pollState(D).nextPollAt <= NOW + 60 + 60, 'and the poll comes back within a minute');
  await h.tickAt(h.db.pollState(D).nextPollAt);
  await h.tickAt(h.db.pollState(D).nextPollAt);
  assert.deepEqual(h.by(organizer, before).map((s) => s.event.kind).sort(), [31923, 31923, 31923, 31923, 31924], 'then the rest, each once');
  h.close();
});

test('a claim to publish itself waits while no relay answers for the organizer, and fails after a day', async () => {
  const h = claimHarness();
  await h.tickAt(NOW);
  const claim = h.queues.requestClaim({ d: D, pubkey: 'a0'.repeat(32), mode: 'own', signer: null, at: NOW });
  h.approve(claim);
  delete (h.held as Record<string, unknown>)[OWN];
  delete (h.held as Record<string, unknown>)['wss://general.test'];
  await h.tickAt(NOW + 60);
  assert.equal(h.queues.claim(claim.id)!.status, 'approved', 'tried again at the next tick');
  assert.equal(h.dir.get(D)!.mode, 'mirrored');
  await h.tickAt(NOW + 86400 + 60);
  assert.deepEqual([h.queues.claim(claim.id)!.status, h.queues.claim(claim.id)!.note], ['failed', 'no relay answered for the organizer for a day']);
  assert.equal(h.dir.get(D)!.mode, 'mirrored');
  h.close();
});

test('a feed that answers 304 is read again in full when its calendar starts being published as its organizer, and for each batch', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]), etag: true, batch: 3 });
  await h.tickAt(NOW);
  assert.ok(h.db.pollState(D).etag, 'the feed has an ETag');
  h.approve(h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW }));
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  assert.equal(h.by(organizer, before).length, 3, 'the first batch goes out though the feed did not change');
  await h.tickAt(h.db.pollState(D).nextPollAt);
  assert.deepEqual(h.by(organizer, before).map((s) => s.event.kind).sort(), [31923, 31923, 31923, 31923, 31924], 'and the rest');
  h.close();
});

test('a claim retried after the index\'s relay failed keeps the connection it made, and a claim that fails keeps none', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const bunker = 'bb'.repeat(32);
  const h = claimHarness({ holds: new Map([[bunker, organizerKey]]) });
  await h.tickAt(NOW);
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(h.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test&secret=one-time`), at: NOW });
  h.approve(claim);
  h.outage.own = 1;
  await h.tickAt(NOW + 60);
  assert.equal(h.queues.claim(claim.id)!.status, 'approved', 'tried again at the next tick');
  assert.equal(h.fake.state.pairs, 1);
  await h.tickAt(NOW + 90);
  assert.equal(h.queues.claim(claim.id)!.status, 'done');
  assert.equal(h.fake.state.pairs, 1, 'the one-time secret is not used twice');
  assert.equal(h.dir.get(D)!.mode, 'delegated');
  h.close();

  const g = claimHarness({ holds: new Map([[bunker, organizerKey]]) });
  await g.tickAt(NOW);
  const failing = g.queues.requestClaim({ d: D, pubkey: organizer, mode: 'delegated', signer: sealFor(g.vault.intakePubkey, `bunker://${bunker}?relay=wss%3A%2F%2Fb.test`), at: NOW });
  g.approve(failing);
  g.outage.own = 1000;
  await g.tickAt(NOW + 60);
  await g.tickAt(NOW + 86400 + 120);
  assert.equal(g.queues.claim(failing.id)!.status, 'failed');
  assert.equal(g.vault.connection(D), null, 'a failed claim leaves no connection');
  g.close();
});

test('a token is found in a description however the feed folds it, and never in an attendee\'s name', async () => {
  const h = claimHarness();
  const folded = h.queues.requestClaim({ d: D, pubkey: 'a0'.repeat(32), mode: 'own', signer: null, at: NOW });
  const attendee = h.queues.requestClaim({ d: D, pubkey: 'b0'.repeat(32), mode: 'own', signer: null, at: NOW });
  const half = Math.floor(folded.token.length / 2);
  const description = `DESCRIPTION:Our group meets monthly. Claim code ${folded.token.slice(0, half)}\r\n ${folded.token.slice(half)} for Event Index.`;
  h.texts[h.dir.get(D)!.feedUrl] = readFixture('meetup-pythonsd.ics')
    .replace('SUMMARY:SDPy Monthly Meetup', `SUMMARY:SDPy Monthly Meetup\r\n${description}\r\nATTENDEE;CN=${attendee.token}:mailto:someone@example.org`);
  await h.tickAt(NOW);
  assert.equal(h.queues.claim(folded.id)!.verifiedBy, 'token');
  assert.equal(h.queues.claim(attendee.id)!.verifiedBy, null);
  h.close();
});

test('the poll service does not hand a calendar to a key that already publishes another itself', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const h = claimHarness({ held: { [OWN]: [], 'wss://general.test': [] } });
  await h.tickAt(NOW);
  h.dir.add({ d: `nostr:${organizer}`, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: 'Lakeside', description: null, image: null,
    location: null, g: null, foundVia: 'owner', addedAt: NOW, mode: 'own', owner: organizer });
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'own', signer: null, at: NOW });
  h.approve(claim);
  await h.tickAt(NOW + 60);
  assert.deepEqual([h.queues.claim(claim.id)!.status, h.queues.claim(claim.id)!.note], ['failed', 'the organizer\'s key already publishes another calendar listed here']);
  assert.equal(h.dir.get(D)!.mode, 'mirrored');
  h.close();
});

test('"I publish myself" while calendar keys are paused: the old key clears its copies from the outside relays and is kept', async () => {
  const organizerKey = generateSecretKey();
  const organizer = getPublicKey(organizerKey);
  const own = finalizeEvent({ kind: 31923, tags: [['d', 'sdpy-nov'], ['title', 'SDPy Monthly Meetup'], ['start', '1792720800']], content: '', created_at: NOW }, organizerKey);
  const h = claimHarness({ held: { [OWN]: [finalizeEvent({ kind: 10002, tags: [['r', HOME]], content: '', created_at: NOW }, organizerKey)], [HOME]: [own] } });
  await h.tickAt(NOW);
  const key = h.dir.get(D)!.pubkey!;
  const signed = new Set(h.by(key).filter((x) => x.audience === 'own' && [31922, 31923, 31924].includes(x.event.kind))
    .map((x) => `${x.event.kind}:${key}:${tag(x.event, 'd')}`));
  // The operator pauses calendar keys (and the service starts again with it).
  h.settings.calendarKeysPaused = true;
  h.settings.publishToGeneralRelays = true;
  const claim = h.queues.requestClaim({ d: D, pubkey: organizer, mode: 'own', signer: null, at: NOW });
  h.approve(claim);
  const before = h.sent.length;
  await h.tickAt(NOW + 60);
  assert.equal(h.queues.claim(claim.id)!.status, 'done');
  const outside = h.by(key, before).filter((x) => x.audience !== 'own').map((x) => x.event);
  assert.equal(JSON.parse(outside.find((e) => e.kind === 0)!.content).name, 'Retired Event Index mirror');
  assert.deepEqual(new Set(outside.filter((e) => e.kind === 5).map((e) => tag(e, 'a'))), signed);
  assert.equal(outside.length, signed.size + 1, 'the profile and one deletion per event, nothing else');
  assert.equal(h.vault.pubkeyFor(D), key, 'the key is kept');
  h.close();
});

