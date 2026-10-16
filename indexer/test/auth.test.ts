// Proof of a nostr key: a NIP-98 event signed for one request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { checkAuth } from '../src/claim/auth.ts';

const sk = generateSecretKey();
const NOW = 1_792_000_000;
const URL = 'https://api.eventindex.space/api/1.0/calendars/meetup-pythonsd/claim';
const BODY = '{"mode":"own"}';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function header(tags: string[][], options: { kind?: number; at?: number; key?: Uint8Array } = {}): string {
  const event = finalizeEvent({ kind: options.kind ?? 27235, tags, content: '', created_at: options.at ?? NOW }, options.key ?? sk);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}
const good = (extra: string[][] = []) => header([['u', URL], ['method', 'POST'], ['payload', hash(BODY)], ...extra]);
const expected = { urls: [URL], method: 'POST', body: BODY, now: NOW };

test('a request signed for this URL, method and body names its key', () => {
  const result = checkAuth(good(), expected);
  assert.deepEqual(result.ok && result.pubkey, getPublicKey(sk));
  assert.ok(result.ok && /^[0-9a-f]{64}$/.test(result.eventId));
});

test('the URL may be any of the request\'s addresses', () => {
  const page = 'https://eventindex.space/api/1.0/calendars/meetup-pythonsd/claim';
  const signed = header([['u', page], ['method', 'post'], ['payload', hash(BODY)]]);
  assert.equal(checkAuth(signed, { ...expected, urls: [URL, page] }).ok, true);
});

test('a request without a valid proof is refused, with the reason', () => {
  const reason = (h: string | undefined, e = expected) => {
    const result = checkAuth(h, e);
    return result.ok ? 'ok' : result.reason;
  };
  assert.equal(reason(undefined), 'missing');
  assert.equal(reason('Bearer abc'), 'missing');
  assert.equal(reason('Nostr not-base64-json'), 'malformed');
  const event = JSON.parse(Buffer.from(good().slice(6), 'base64').toString()) as Record<string, unknown>;
  assert.equal(reason(`Nostr ${Buffer.from(JSON.stringify({ ...event, content: 'changed' })).toString('base64')}`), 'bad-signature');
  assert.equal(reason(header([['u', URL], ['method', 'POST'], ['payload', hash(BODY)]], { kind: 1 })), 'wrong-kind');
  assert.equal(reason(header([['u', URL], ['method', 'POST'], ['payload', hash(BODY)]], { at: NOW - 61 })), 'expired');
  assert.equal(reason(header([['u', URL], ['method', 'POST'], ['payload', hash(BODY)]], { at: NOW + 61 })), 'expired');
  assert.equal(reason(header([['u', `${URL}/other`], ['method', 'POST'], ['payload', hash(BODY)]])), 'wrong-url');
  assert.equal(reason(header([['u', URL], ['method', 'GET'], ['payload', hash(BODY)]])), 'wrong-method');
  assert.equal(reason(header([['u', URL], ['method', 'POST'], ['payload', hash('{"mode":"delegated"}')]])), 'wrong-payload');
  assert.equal(reason(header([['u', URL], ['method', 'POST']])), 'wrong-payload', 'a body must be signed');
});
