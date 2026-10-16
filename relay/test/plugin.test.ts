// The write policy as strfry runs it: a process reading one request per line.
// Deletions are checked against a local relay (`nak serve`; skipped without nak).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';

const repo = new URL('../../', import.meta.url).pathname;
const hasNak = spawnSync('nak', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'policy-'));
const allowlistFile = join(dir, 'relay-allowlist.json');
const indexKey = generateSecretKey();
const calendarKey = generateSecretKey();
const stranger = generateSecretKey();
let relay: ReturnType<typeof spawn> | null = null;
let relayUrl = 'ws://127.0.0.1:1';
let plugin: ChildProcessWithoutNullStreams;
let responses: AsyncIterator<string>;
const pool = new SimplePool();

function writeAllowlist(content: object): void {
  writeFileSync(`${allowlistFile}.tmp`, JSON.stringify(content));
  renameSync(`${allowlistFile}.tmp`, allowlistFile);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function ask(event: object, sourceType = 'IP4'): Promise<{ id: string; action: string; msg?: string }> {
  plugin.stdin.write(`${JSON.stringify({ type: 'new', event, receivedAt: Math.floor(Date.now() / 1000), sourceType, sourceInfo: '192.0.2.1' })}\n`);
  const next = await responses.next();
  return JSON.parse(next.value as string);
}

const now = () => Math.floor(Date.now() / 1000);
const sign = (sk: Uint8Array, kind: number, tags: string[][] = []) => finalizeEvent({ kind, tags, content: '', created_at: now() }, sk);

before(async () => {
  if (hasNak) {
    const port = await freePort();
    relayUrl = `ws://127.0.0.1:${port}`;
    relay = spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '-qq'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i += 1) {
      const open = await new Promise<boolean>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
        socket.on('error', () => resolve(false));
      });
      if (open) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  writeAllowlist({ index: getPublicKey(indexKey), live: [getPublicKey(calendarKey)], removed: [] });
  plugin = spawn(join(repo, 'relay/write-policy'), [], { env: { ...process.env, EVENTINDEX_RELAY_ALLOWLIST: allowlistFile, EVENTINDEX_RELAY_URL: relayUrl } });
  responses = createInterface({ input: plugin.stdout })[Symbol.asyncIterator]();
});

after(() => {
  plugin.kill();
  relay?.kill();
  pool.close([relayUrl]);
  rmSync(dir, { recursive: true, force: true });
});

test('the plugin answers each request with the event id and a decision', async () => {
  const own = sign(calendarKey, 31923, [['d', 'x']]);
  assert.deepEqual(await ask(own), { id: own.id, action: 'accept' });
  const note = sign(stranger, 1);
  const refused = await ask(note);
  assert.equal(refused.id, note.id);
  assert.equal(refused.action, 'reject');
  assert.match(refused.msg!, /^blocked: .*kind 1/);
  const rsvp = sign(stranger, 31925, [['d', 'r'], ['a', `31923:${getPublicKey(calendarKey)}:x`], ['status', 'accepted']]);
  assert.equal((await ask(rsvp)).action, 'accept');
});

test('a changed allowlist is read without a restart', async () => {
  const pid = plugin.pid;
  const added = generateSecretKey();
  assert.equal((await ask(sign(added, 31923))).action, 'reject');
  writeAllowlist({ index: getPublicKey(indexKey), live: [getPublicKey(calendarKey), getPublicKey(added)], removed: [] });
  assert.equal((await ask(sign(added, 31923))).action, 'accept');
  writeAllowlist({ index: getPublicKey(indexKey), live: [getPublicKey(calendarKey)], removed: [getPublicKey(added)] });
  assert.equal((await ask(sign(added, 31923))).action, 'reject', 'a removed calendar publishes no events');
  assert.equal((await ask(sign(added, 0))).action, 'accept', 'its removed profile still goes out');
  assert.equal(plugin.pid, pid);
});

test('a deletion is accepted only for the author\'s own events stored on the relay', { skip: !hasNak && 'nak is not installed' }, async () => {
  const rsvp = sign(stranger, 31925, [['d', 'mine'], ['a', `31923:${getPublicKey(calendarKey)}:x`], ['status', 'accepted']]);
  await Promise.all(pool.publish([relayUrl], rsvp));
  const byId = sign(stranger, 5, [['e', rsvp.id], ['k', '31925']]);
  assert.equal((await ask(byId)).action, 'accept');
  const byAddress = sign(stranger, 5, [['a', `31925:${getPublicKey(stranger)}:mine`], ['k', '31925']]);
  assert.equal((await ask(byAddress)).action, 'accept');
  const notStored = sign(stranger, 5, [['e', 'f'.repeat(64)]]);
  assert.match((await ask(notStored)).msg!, /your own events/);
  const someoneElses = sign(generateSecretKey(), 5, [['e', rsvp.id]]);
  assert.equal((await ask(someoneElses)).action, 'reject');
});

test('operator imports are not filtered', async () => {
  assert.equal((await ask(sign(stranger, 1), 'Import')).action, 'accept');
});
