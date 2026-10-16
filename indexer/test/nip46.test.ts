// The index's NIP-46 client: requests to an organizer's remote signer, and
// answers that may be anything at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { openNip46, type Nip46Pool } from '../src/claim/nip46.ts';

const clientKey = generateSecretKey();
const signerKey = generateSecretKey();
const signer = getPublicKey(signerKey);
const toClient = getConversationKey(signerKey, getPublicKey(clientKey));

// A relay pool in memory, and a signer behind it that answers as told.
function world(answer: (request: { id: string; method: string; params: string[] }) => unknown[]) {
  const listeners: Array<(event: VerifiedEvent) => void> = [];
  const sent: VerifiedEvent[] = [];
  const pool: Nip46Pool = {
    subscribeMany(_relays, _filter, params) {
      listeners.push(params.onevent as (event: VerifiedEvent) => void);
      queueMicrotask(() => params.oneose?.());
      return { close: () => { listeners.length = 0; } };
    },
    publish(_relays, event) {
      sent.push(event);
      const request = JSON.parse(decrypt(event.content, toClient));
      setTimeout(() => {
        for (const reply of answer(request)) {
          const content = typeof reply === 'string' ? reply : encrypt(JSON.stringify(reply), toClient);
          const response = finalizeEvent({ kind: 24133, tags: [['p', getPublicKey(clientKey)]], content, created_at: Math.floor(Date.now() / 1000) }, signerKey);
          for (const listener of [...listeners]) listener(response);
        }
      }, 5);
      return [Promise.resolve('')];
    },
  };
  return { pool, sent };
}

const remote = { pubkey: signer, relays: ['wss://bunker.example.org'] };

test('a request is sent encrypted to the signer, and its answer is matched by id', async () => {
  const { pool, sent } = world((r) => [{ id: r.id, result: r.method === 'get_public_key' ? 'ab'.repeat(32) : 'pong' }]);
  const client = await openNip46(pool, clientKey, remote, 1000);
  assert.equal(await client.request('get_public_key', []), 'ab'.repeat(32));
  assert.equal(sent[0]!.kind, 24133);
  assert.deepEqual(sent[0]!.tags, [['p', signer]]);
  assert.ok(!sent[0]!.content.includes('get_public_key'), 'the request is encrypted');
  client.close();
});

test('answers that cannot be read, or are not for a request, are ignored; an error answer fails the request', async () => {
  const { pool } = world((r) => [
    'not nip-44 at all',
    { id: 'someone-else', result: 'x' },
    r.method === 'sign_event' ? { id: r.id, result: '', error: 'not allowed' } : { id: r.id, result: 'ok' },
  ]);
  const client = await openNip46(pool, clientKey, remote, 1000);
  assert.equal(await client.request('connect', [signer, '', 'sign_event:31923']), 'ok');
  await assert.rejects(client.request('sign_event', ['{}']), /not allowed/);
  client.close();
});

test('an auth_url answer keeps the request waiting, and a signer that never answers times out', async () => {
  const { pool } = world((r) => (r.method === 'ping' ? [] : [{ id: r.id, result: 'auth_url', error: 'https://signer.example.org/approve' }, { id: r.id, result: 'pong' }]));
  const client = await openNip46(pool, clientKey, remote, 200);
  assert.equal(await client.request('describe', []), 'pong');
  await assert.rejects(client.request('ping', []), /did not answer/);
  client.close();
});

test('answers from another key are ignored', async () => {
  const stranger = generateSecretKey();
  const listeners: Array<(event: VerifiedEvent) => void> = [];
  const pool: Nip46Pool = {
    subscribeMany(_r, _f, params) { listeners.push(params.onevent as (e: VerifiedEvent) => void); queueMicrotask(() => params.oneose?.()); return { close() {} }; },
    publish(_r, event) {
      const request = JSON.parse(decrypt(event.content, toClient));
      const key = getConversationKey(stranger, getPublicKey(clientKey));
      const forged = finalizeEvent({ kind: 24133, tags: [['p', getPublicKey(clientKey)]], content: encrypt(JSON.stringify({ id: request.id, result: 'forged' }), key), created_at: Math.floor(Date.now() / 1000) }, stranger);
      setTimeout(() => listeners.forEach((l) => l(forged)), 5);
      return [Promise.resolve('')];
    },
  };
  const client = await openNip46(pool, clientKey, remote, 200);
  await assert.rejects(client.request('get_public_key', []), /did not answer/);
  client.close();
});
