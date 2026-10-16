// Calendars published from their organizers' own keys, against local relays
// (`nak serve`, and `nak bunker` for a remote signer; skipped without nak).
// Every key is made for the test and thrown away.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer } from '../src/service/indexer.ts';
import { relayPublisher } from '../src/service/publisher.ts';
import { loadSettings } from '../src/config.ts';
import { nativeD } from '../src/directory/id.ts';
import { poolReader } from '../src/native/read.ts';
import { nip46Signers } from '../src/claim/signer.ts';
import { sealFor } from '../src/claim/seal.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const hasNak = spawnSync('nak', ['--version']).status === 0;
const skip = !hasNak && 'nak is not installed';
const relays: Array<{ url: string; proc: ChildProcess }> = [];
const bunkers: ChildProcess[] = [];
const pool = new SimplePool();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('relay did not start');
}

async function relay(): Promise<string> {
  const port = await freePort();
  const proc = spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '-qq'], { stdio: 'ignore' });
  await waitForPort(port);
  const url = `ws://127.0.0.1:${port}`;
  relays.push({ url, proc });
  return url;
}

after(() => {
  pool.destroy();
  for (const b of bunkers) b.kill();
  for (const r of relays) r.proc.kill();
});

// A remote signer (NIP-46) holding a key, on a relay; resolves to its
// bunker:// address.
async function bunker(key: Uint8Array, relayUrl: string): Promise<string> {
  const proc = spawn('nak', ['bunker', '--sec', Buffer.from(key).toString('hex'), relayUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  bunkers.push(proc);
  let out = '';
  proc.stdout!.on('data', (chunk) => { out += chunk; });
  proc.stderr!.on('data', (chunk) => { out += chunk; });
  for (let i = 0; i < 200; i += 1) {
    const found = /bunker: (bunker:\/\/\S+)/.exec(out);
    if (found) return found[1]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nak bunker did not start: ${out}`);
}

// The index's own relay and an organizer's home relay.
async function world() {
  const own = await relay();
  const home = await relay();
  const settings = loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: own, EVENTINDEX_GENERAL_RELAYS: 'none', EVENTINDEX_PROFILE_RELAYS: 'none' });
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const events = eventStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const readPool = new SimplePool();
  const publisher = relayPublisher(settings, () => {});
  const clock = { now: NOW };
  const queues = queueStore(db);
  const indexer = createIndexer({
    db, dir, queues, events, vault, indexKey, settings, publisher,
    reader: poolReader(readPool, 2000),
    signers: nip46Signers(readPool, 10_000),
    // Local relays, for the rehearsal only.
    relayAllowed: async () => true,
    now: () => clock.now,
    fetch: async (u) => ({ status: 'ok', text: readFixture('meetup-pythonsd.ics'), etag: null, lastModified: null, finalUrl: u }),
    log: () => {},
  });
  return {
    own, home, db, dir, queues, events, vault, indexer, clock, indexPubkey: getPublicKey(indexKey),
    close() { publisher.close(); readPool.destroy(); vault.close(); db.close(); },
  };
}

test('a native calendar: the organizer publishes to their own relay, and the index serves their events', { skip }, async () => {
  const w = await world();
  try {
    const organizerKey = generateSecretKey();
    const organizer = getPublicKey(organizerKey);
    const sign = (kind: number, tags: string[][], content = '') => finalizeEvent({ kind, tags, content, created_at: NOW - 600 }, organizerKey);
    // The organizer's relay list is on the index's usual relays; the events
    // only on their home relay.
    await Promise.all(pool.publish([w.own], sign(10002, [['r', w.home]])));
    for (const event of [
      sign(0, [], JSON.stringify({ display_name: 'Lakeside Bitcoin Club', about: 'Monthly meetups.' })),
      sign(31923, [['d', 'oct'], ['title', 'October meetup'], ['start', String(NOW + 3 * 86400)], ['start_tzid', 'America/Chicago']]),
      sign(31922, [['d', 'fest'], ['title', 'Harvest festival'], ['start', '2026-10-24']]),
    ]) await Promise.all(pool.publish([w.home], event));

    w.dir.add({ d: nativeD(organizer), role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: null, description: null, image: null,
      location: 'Chicago, US', g: 'dp3w', foundVia: 'owner', addedAt: NOW, mode: 'own', owner: organizer });
    const report = await w.indexer.tick();
    assert.deepEqual(report.failed, []);
    const entry = w.dir.get(nativeD(organizer))!;
    assert.equal(entry.name, 'Lakeside Bitcoin Club');
    assert.deepEqual(entry.ownerRelays, [w.home]);
    assert.deepEqual(w.events.byCalendar(entry.d, NOW - 86400, NOW + 30 * 86400).map((r) => r.title), ['October meetup', 'Harvest festival']);
    const onOwn = await pool.querySync([w.own], { authors: [organizer] });
    assert.deepEqual(onOwn.map((e) => e.kind), [10002], 'the index publishes nothing as the organizer');
    const listed = await pool.querySync([w.own], { kinds: [39999], authors: [w.indexPubkey] });
    assert.deepEqual(listed[0]!.tags.find((t) => t[0] === 'p'), ['p', organizer]);
  } finally {
    w.close();
  }
});

test('"publish for me, as me" through a real remote signer: the calendar\'s events go out under the organizer\'s key', { skip }, async () => {
  const w = await world();
  try {
    const organizerKey = generateSecretKey();
    const organizer = getPublicKey(organizerKey);
    await Promise.all(pool.publish([w.own], finalizeEvent({ kind: 10002, tags: [['r', w.home]], content: '', created_at: NOW }, organizerKey)));
    const id = identify(feedUrlFor('meetup-pythonsd.ics'));
    w.dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
      location: 'San Diego, US', g: '9mud', foundVia: 'maintainer', addedAt: NOW });
    await w.indexer.tick();
    const key = w.dir.get(id.d)!.pubkey!;
    assert.equal((await pool.querySync([w.own], { kinds: [31923], authors: [key] })).length, 4, 'mirrored first, under the calendar key');

    const address = await bunker(organizerKey, w.home);
    const claim = w.queues.requestClaim({ d: id.d, pubkey: organizer, mode: 'delegated', signer: sealFor(w.vault.intakePubkey, address), at: NOW });
    w.queues.markClaimVerified(claim.id, 'token', null, NOW);
    w.queues.resolveClaim(claim.id, 'approved', NOW);
    w.clock.now = NOW + 60;
    const report = await w.indexer.tick();
    assert.deepEqual([w.queues.claim(claim.id)!.status, w.queues.claim(claim.id)!.note], ['done', null]);
    assert.deepEqual(report.failed, []);
    assert.equal(w.vault.connection(id.d)!.owner, organizer);

    const theirs = await pool.querySync([w.home], { authors: [organizer] });
    assert.deepEqual(theirs.map((e) => e.kind).sort(), [31923, 31923, 31923, 31923, 31924], 'signed by the organizer\'s signer, on their relay');
    assert.equal((await pool.querySync([w.own], { kinds: [31923], authors: [organizer] })).length, 0, 'the index\'s relay does not host them');
    const old = await pool.querySync([w.own], { kinds: [0], authors: [key] });
    assert.match(JSON.parse(old[0]!.content).about, /now publishes as npub1/);
    assert.equal((await pool.querySync([w.own], { kinds: [31923], authors: [key] })).length, 0, 'the old copies are deleted');

    const off = w.queues.ownerRequest({ d: id.d, pubkey: organizer, kind: 'disconnect', signer: null, at: NOW + 70 });
    w.clock.now = NOW + 120;
    await w.indexer.tick();
    assert.equal(w.queues.claim(off)!.status, 'done');
    assert.equal(w.vault.connection(id.d), null);
    assert.equal(w.dir.get(id.d)!.mode, 'own');
    assert.equal(w.events.byCalendar(id.d, NOW, NOW + 365 * 86400).length, 4, 'its events are now read as the organizer\'s own');
  } finally {
    w.close();
  }
});
