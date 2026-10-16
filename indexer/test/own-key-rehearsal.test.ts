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
import { NOW } from './helpers.ts';

const hasNak = spawnSync('nak', ['--version']).status === 0;
const skip = !hasNak && 'nak is not installed';
const relays: Array<{ url: string; proc: ChildProcess }> = [];
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
  for (const r of relays) r.proc.kill();
});

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
  const indexer = createIndexer({
    db, dir, queues: queueStore(db), events, vault, indexKey, settings, publisher,
    reader: poolReader(readPool, 2000),
    // Local relays, for the rehearsal only.
    relayAllowed: async () => true,
    now: () => clock.now,
    fetch: async () => ({ status: 'error', code: 'http-404' }),
    log: () => {},
  });
  return {
    own, home, db, dir, events, vault, indexer, clock, indexPubkey: getPublicKey(indexKey),
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
