// The poll service against a local relay (`nak serve`; skipped without nak).
// Keys are made for the test and thrown away.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer } from '../src/service/indexer.ts';
import { relayPublisher } from '../src/service/publisher.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const hasNak = spawnSync('nak', ['--version']).status === 0;
const skip = !hasNak && 'nak is not installed';
const repo = new URL('../../', import.meta.url).pathname;
let relay: ChildProcess | null = null;
let url = '';
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

before(async () => {
  if (!hasNak) return;
  const port = await freePort();
  url = `ws://127.0.0.1:${port}`;
  relay = spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '-qq'], { stdio: 'ignore' });
  await waitForPort(port);
});

after(() => {
  if (url) pool.close([url]);
  relay?.kill();
});

test('one tick publishes the directory, the calendar key\'s events and the calendar to the relay', { skip }, async () => {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const settings = { ...loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: url }) };
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null, location: 'San Diego, US', g: '9mud', foundVia: 'maintainer', addedAt: NOW });
  const publisher = relayPublisher(settings, () => {});
  const indexer = createIndexer({
    db, dir, queues: queueStore(db), events: eventStore(db), vault, indexKey, settings, publisher,
    now: () => NOW,
    fetch: async (u) => ({ status: 'ok', text: readFixture('meetup-pythonsd.ics'), etag: null, lastModified: null, finalUrl: u }),
    log: () => {},
  });
  await indexer.tick();
  publisher.close();
  const indexPubkey = getPublicKey(indexKey);
  const calendarPubkey = dir.get(id.d)!.pubkey!;
  const directory = await pool.querySync([url], { kinds: [39998, 39999], authors: [indexPubkey] });
  assert.deepEqual(directory.map((e) => e.kind).sort(), [39998, 39999], 'the events header and the entry');
  const listed = await pool.querySync([url], { kinds: [31923], '#z': [`39998:${indexPubkey}:events`] });
  assert.equal(listed.length, 4);
  assert.ok(listed.every((e) => e.pubkey === calendarPubkey));
  const calendar = await pool.querySync([url], { kinds: [31924], authors: [calendarPubkey] });
  assert.equal(calendar[0]!.tags.filter((t) => t[0] === 'a').length, 4);
});

function serviceEnv(dataDir: string): NodeJS.ProcessEnv {
  const keyFile = join(dataDir, 'index-key.nsec');
  const secretFile = join(dataDir, 'calendar-key.secret');
  const signerFile = join(dataDir, 'signer.secret');
  writeFileSync(keyFile, `${nsecEncode(generateSecretKey())}\n`);
  writeFileSync(secretFile, `${randomBytes(32).toString('hex')}\n`);
  writeFileSync(signerFile, `${randomBytes(32).toString('hex')}\n`);
  return {
    ...process.env, EVENTINDEX_DATA_DIR: dataDir, EVENTINDEX_INDEX_KEY_FILE: keyFile, EVENTINDEX_CALENDAR_SECRET_FILE: secretFile,
    EVENTINDEX_SIGNER_SECRET_FILE: signerFile, EVENTINDEX_RELAY_URL: url,
  };
}

test('main.ts --once runs one tick, publishes the index key\'s events, and releases its lock', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'svc-'));
  try {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/main.ts', '--once'], { cwd: repo, env: serviceEnv(dataDir), encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /indexer started as npub1.*general relays off; claimants not hosted on the relay; NIP-52 ingestion off/);
    assert.match(run.stdout, /stopped/);
    assert.equal(existsSync(join(dataDir, 'indexer.lock')), false);
    assert.ok(existsSync(join(dataDir, 'index.db')) && existsSync(join(dataDir, 'vault.db')));
    const headers = await pool.querySync([url], { kinds: [39998], '#d': ['events'] });
    assert.ok(headers.length >= 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('main.ts stops cleanly on SIGTERM', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'svc-'));
  try {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/main.ts'], { cwd: repo, env: serviceEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    for (let i = 0; i < 200 && !/indexer started/.test(out); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /indexer started/);
    const second = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/main.ts', '--once'], { cwd: repo, env: { ...serviceEnv(dataDir) }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(second.status, 1, 'a second indexer on the same data directory refuses to start');
    assert.match(second.stdout, /held by process/);
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
    assert.match(out, /SIGTERM: stopping/);
    assert.equal(existsSync(join(dataDir, 'indexer.lock')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('turning outside publishing on fills each set of relays with its kinds, from the index\'s relay', { skip }, async () => {
  const relays: Record<string, { url: string; proc: ChildProcess }> = {};
  for (const name of ['search', 'lists', 'profiles', 'general']) {
    const port = await freePort();
    relays[name] = { url: `ws://127.0.0.1:${port}`, proc: spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '-qq'], { stdio: 'ignore' }) };
    await waitForPort(port);
  }
  try {
    const env = {
      EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_URL: url,
      EVENTINDEX_SEARCH_RELAYS: relays['search']!.url, EVENTINDEX_LIST_RELAYS: relays['lists']!.url,
      EVENTINDEX_PROFILE_RELAYS: relays['profiles']!.url, EVENTINDEX_GENERAL_RELAYS: relays['general']!.url,
    };
    const db = openIndexDb(':memory:');
    const dir = directoryStore(db);
    const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
    const indexKey = generateSecretKey();
    const id = identify(feedUrlFor('luma-calendar-craftnook.ics'));
    dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'maintainer', addedAt: NOW });
    const fast = { search: { perSecond: 500, burst: 50 }, lists: { perSecond: 500, burst: 50 }, profiles: { perSecond: 500, burst: 50 }, general: { perSecond: 500, burst: 50 } };
    const run = async (publish: boolean, now: number) => {
      const settings = { ...loadSettings(env), publishToGeneralRelays: publish };
      const publisher = relayPublisher(settings, () => {}, { pace: fast });
      const indexer = createIndexer({
        db, dir, queues: queueStore(db), events: eventStore(db), vault, indexKey, settings, publisher, now: () => now,
        fetch: async (u) => ({ status: 'ok', text: readFixture('luma-calendar-craftnook.ics'), etag: null, lastModified: null, finalUrl: u }),
        log: () => {},
      });
      await indexer.tick();
      for (let i = 0; i < 400 && (publisher.pending?.() ?? 0) > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      await indexer.tick();
      publisher.close();
    };
    await run(false, NOW);
    const calendar = dir.get(id.d)!.pubkey!;
    const indexPubkey = getPublicKey(indexKey);
    const kinds = async (name: string, authors: string[]) =>
      (await pool.querySync([relays[name]!.url], { authors })).map((e) => e.kind).sort((a, b) => a - b);
    assert.deepEqual(await kinds('search', [indexPubkey, calendar]), [], 'off: nothing to the search relays');
    assert.deepEqual(await kinds('profiles', [indexPubkey]), [0, 10002], 'off: the index key\'s profile still goes out');

    await run(true, NOW + 60);
    for (const name of ['search', 'profiles', 'general']) assert.equal(dir.fact(`outside_backfill ${relays[name]!.url}`), '1', name);
    // craftnook at NOW: four events in the window, one of them past.
    assert.deepEqual(await kinds('search', [calendar]), [0, 10002, 31923, 31923, 31923, 31923, 31924]);
    assert.deepEqual(await kinds('search', [indexPubkey]), [0, 3, 10002], 'the directory is held');
    assert.deepEqual(await kinds('lists', [indexPubkey, calendar]), []);
    assert.deepEqual(await kinds('profiles', [calendar]), [0, 10002]);
    assert.deepEqual(await kinds('profiles', [indexPubkey]), [0, 3, 10002]);
    assert.deepEqual(await kinds('general', [calendar]), [0, 10002, 31923, 31923, 31923, 31924], 'upcoming events only');
    assert.deepEqual(await kinds('general', [indexPubkey]), [0, 3, 10002]);
    vault.close();
    db.close();
  } finally {
    for (const r of Object.values(relays)) { pool.close([r.url]); r.proc.kill(); }
  }
});

test('main.ts refuses to start without the calendar-key secret while the vault holds calendar keys, and starts once it holds none', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'svc-'));
  try {
    const env = serviceEnv(dataDir);
    const signer = Buffer.from(String(readFileSync(env['EVENTINDEX_SIGNER_SECRET_FILE']!, 'utf8')).trim(), 'hex');
    const calendar = Buffer.from(String(readFileSync(env['EVENTINDEX_CALENDAR_SECRET_FILE']!, 'utf8')).trim(), 'hex');
    const vault = openVault(join(dataDir, 'vault.db'), new Uint8Array(signer), new Uint8Array(calendar));
    vault.createKey('luma:cal-x');
    vault.close();
    const without = { ...env, EVENTINDEX_CALENDAR_SECRET_FILE: join(dataDir, 'gone.secret'), EVENTINDEX_CALENDAR_KEYS_PAUSED: '1' };
    const refused = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/main.ts', '--once'], { cwd: repo, env: without, encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /holds 1 calendar keys, and the calendar-key secret is missing/);
    const again = openVault(join(dataDir, 'vault.db'), new Uint8Array(signer), new Uint8Array(calendar));
    again.destroyKeys();
    again.close();
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/main.ts', '--once'], { cwd: repo, env: without, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /calendar keys paused/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
