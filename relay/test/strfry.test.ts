// The poll service publishing to strfry with the write policy, as on the
// server: the repository's strfry.conf and relay/ in a container built from
// relay/test/strfry.Dockerfile (skipped when that image or Docker is absent).
// Keys are made for the test and thrown away.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { openIndexDb } from '../../indexer/src/store/index-db.ts';
import { openVault } from '../../indexer/src/store/vault-db.ts';
import { directoryStore } from '../../indexer/src/store/directory.ts';
import { queueStore } from '../../indexer/src/store/queues.ts';
import { eventStore } from '../../indexer/src/store/events.ts';
import { createIndexer } from '../../indexer/src/service/indexer.ts';
import { relayPublisher } from '../../indexer/src/service/publisher.ts';
import { loadSettings } from '../../indexer/src/config.ts';
import { identify } from '../../indexer/src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from '../../indexer/test/helpers.ts';

const IMAGE = 'eventindex-strfry-test';
const repo = new URL('../../', import.meta.url).pathname;
const ready = spawnSync('docker', ['image', 'inspect', IMAGE]).status === 0;
const skip = !ready && `the ${IMAGE} image is not built (see relay/README.md)`;
const dataDir = mkdtempSync(join(tmpdir(), 'strfry-'));
let container = '';
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

before(async () => {
  if (!ready) return;
  chmodSync(dataDir, 0o777);
  // The repository's config, reachable from outside the container.
  const conf = readFileSync(join(repo, 'relay/strfry.conf'), 'utf8').replace(/bind = "127\.0\.0\.1"/, 'bind = "0.0.0.0"');
  writeFileSync(join(dataDir, 'strfry.conf'), conf);
  const port = await freePort();
  const run = spawnSync('docker', ['run', '-d', '--rm', '-p', `127.0.0.1:${port}:7777`,
    '-v', `${join(repo, 'relay')}:/opt/eventindex/app/relay:ro`,
    '-v', `${dataDir}:/var/lib/eventindex`,
    '-v', `${join(dataDir, 'strfry.conf')}:/etc/strfry.conf:ro`,
    '-e', 'EVENTINDEX_RELAY_ALLOWLIST=/var/lib/eventindex/relay-allowlist.json',
    IMAGE], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  container = run.stdout.trim();
  url = `ws://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const info = await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: 'application/nostr+json' } });
      if (info.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (url) pool.close([url]);
  if (container) spawnSync('docker', ['rm', '-f', container]);
  rmSync(dataDir, { recursive: true, force: true });
});

async function refusal(event: ReturnType<typeof finalizeEvent>): Promise<string | null> {
  try {
    await Promise.all(pool.publish([url], event));
    return null;
  } catch (error) {
    return String((error as Error).message ?? error);
  }
}

test('NIP-11 states the relay\'s scope', { skip }, async () => {
  const info = await (await fetch(url.replace('ws://', 'http://'), { headers: { Accept: 'application/nostr+json' } })).json() as { description: string };
  assert.match(info.description, /only/);
  assert.match(info.description, /31925/);
  assert.match(info.description, /1111/);
});

test('the poll service publishes through the write policy; strangers get only answers in', { skip }, async () => {
  const settings = loadSettings({ EVENTINDEX_DATA_DIR: dataDir, EVENTINDEX_RELAY_URL: url });
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const id = identify(feedUrlFor('meetup-pythonsd.ics'));
  dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null, location: null, g: null, foundVia: 'maintainer', addedAt: NOW });
  const clock = { now: NOW };
  const publisher = relayPublisher(settings, () => {});
  const indexer = createIndexer({
    db, dir, queues, events: eventStore(db), vault, indexKey, settings, publisher,
    now: () => clock.now,
    fetch: async (u) => ({ status: 'ok', text: readFixture('meetup-pythonsd.ics'), etag: null, lastModified: null, finalUrl: u }),
    log: () => {},
  });
  try {
    const first = await indexer.tick();
    assert.deepEqual(first.failed, [], 'every publish was accepted');
    const calendar = dir.get(id.d)!.pubkey!;
    const events = await pool.querySync([url], { kinds: [31923], authors: [calendar] });
    assert.equal(events.length, 4);
    assert.equal((await pool.querySync([url], { kinds: [39999], authors: [getPublicKey(indexKey)] })).length, 1);

    const stranger = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const coordinate = `31923:${calendar}:${events[0]!.tags.find((t) => t[0] === 'd')![1]}`;
    const note = finalizeEvent({ kind: 1, tags: [], content: 'hello', created_at: now }, stranger);
    assert.match((await refusal(note))!, /blocked: /);
    const fake = finalizeEvent({ kind: 31923, tags: [['d', 'x'], ['title', 'Not ours'], ['start', String(now)]], content: '', created_at: now }, stranger);
    assert.match((await refusal(fake))!, /blocked: /);
    const rsvp = finalizeEvent({ kind: 31925, tags: [['d', 'r1'], ['a', coordinate], ['status', 'accepted'], ['p', calendar]], content: '', created_at: now }, stranger);
    assert.equal(await refusal(rsvp), null);
    const comment = finalizeEvent({ kind: 1111, tags: [['A', coordinate], ['K', '31923'], ['P', calendar], ['a', coordinate], ['k', '31923'], ['p', calendar]], content: 'See you there', created_at: now }, stranger);
    assert.equal(await refusal(comment), null);
    const othersDeletion = finalizeEvent({ kind: 5, tags: [['e', rsvp.id]], content: '', created_at: now }, generateSecretKey());
    assert.match((await refusal(othersDeletion))!, /blocked: .*your own events/);
    const ownDeletion = finalizeEvent({ kind: 5, tags: [['e', rsvp.id], ['k', '31925']], content: '', created_at: now + 1 }, stranger);
    assert.equal(await refusal(ownDeletion), null);
    assert.equal((await pool.querySync([url], { ids: [rsvp.id] })).length, 0, 'the deleted RSVP is gone');

    // A removal still publishes; afterwards the calendar's key is held to its profile and deletions.
    const { id: request } = queues.requestRemoval({ d: id.d, message: null, at: NOW });
    queues.resolveRemoval(request, 'approved', NOW);
    clock.now = NOW + 60;
    const second = await indexer.tick();
    assert.deepEqual(second.removed, [id.d]);
    assert.equal((await pool.querySync([url], { kinds: [31923], authors: [calendar] })).length, 0, 'upcoming events deleted');
    const profile = (await pool.querySync([url], { kinds: [0], authors: [calendar] }))[0]!;
    assert.match(JSON.parse(profile.content).about, /No longer mirrored/);
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'relay-allowlist.json'), 'utf8')).removed[0], calendar);
  } finally {
    publisher.close();
    vault.close();
    db.close();
  }
});
