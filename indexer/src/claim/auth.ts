// Proof that a request comes from the holder of a nostr key: a NIP-98 event
// (kind 27235) signed for the request's URL, method and body, within a minute
// of now, as a browser extension (NIP-07) or any signer can make it. The
// caller keeps the event's id, so one proof is used once.

import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

export const AUTH_KIND = 27235;
export const AUTH_WINDOW = 60;

export type AuthCheck =
  | { ok: true; pubkey: string; eventId: string; createdAt: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'bad-signature' | 'wrong-kind' | 'expired' | 'wrong-url' | 'wrong-method' | 'wrong-payload' };

export interface AuthExpected {
  // The request's URL, as any of the addresses it is served at.
  urls: string[];
  method: string;
  // The request body, as sent.
  body: string;
  now: number;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function checkAuth(header: string | undefined, expected: AuthExpected): AuthCheck {
  const match = /^Nostr\s+(\S+)$/.exec(header?.trim() ?? '');
  if (!match) return { ok: false, reason: 'missing' };
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!event || typeof event !== 'object' || !Array.isArray(event['tags'])) return { ok: false, reason: 'malformed' };
  const { id, pubkey, kind, created_at, tags, content, sig } = event;
  const plain = { id, pubkey, kind, created_at, tags, content, sig } as Parameters<typeof verifyEvent>[0];
  let valid = false;
  try {
    valid = verifyEvent(plain);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };
  if (kind !== AUTH_KIND) return { ok: false, reason: 'wrong-kind' };
  if (Math.abs(expected.now - (created_at as number)) > AUTH_WINDOW) return { ok: false, reason: 'expired' };
  const tag = (name: string) => (tags as string[][]).find((t) => t[0] === name)?.[1];
  if (!expected.urls.includes(tag('u') ?? '')) return { ok: false, reason: 'wrong-url' };
  if ((tag('method') ?? '').toUpperCase() !== expected.method.toUpperCase()) return { ok: false, reason: 'wrong-method' };
  if (expected.body && tag('payload') !== sha256(expected.body)) return { ok: false, reason: 'wrong-payload' };
  return { ok: true, pubkey: pubkey as string, eventId: id as string, createdAt: created_at as number };
}
