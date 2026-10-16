// A NIP-46 client for the index: requests to an organizer's remote signer,
// as kind 24133 events encrypted with NIP-44, and their answers matched by
// id. Whatever a relay or a signer sends back, an answer that cannot be read
// is ignored, never thrown: a request then times out and fails on its own.

import { randomBytes } from 'node:crypto';
import { finalizeEvent, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import type { Filter } from 'nostr-tools/filter';

export const NIP46_KIND = 24133;
// How long to wait for the subscription to be in place before asking.
const READY_WAIT_MS = 3000;

// What the client needs of a relay pool (nostr-tools' SimplePool).
export interface Nip46Pool {
  subscribeMany(relays: string[], filter: Filter, params: { onevent?: (event: never) => void; oneose?: () => void }): { close(reason?: string): void };
  publish(relays: string[], event: VerifiedEvent): Promise<string>[];
}

export interface Nip46Client {
  request(method: string, params: string[]): Promise<string>;
  close(): void;
}

interface Answer {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export async function openNip46(pool: Nip46Pool, clientSecret: Uint8Array, remote: { pubkey: string; relays: string[] }, timeoutMs: number): Promise<Nip46Client> {
  const client = getPublicKey(clientSecret);
  const key = getConversationKey(clientSecret, remote.pubkey);
  const waiting = new Map<string, { resolve: (result: string) => void; reject: (error: Error) => void }>();
  let ready: () => void = () => {};
  const subscribed = new Promise<void>((resolve) => { ready = resolve; });

  const onevent = (event: VerifiedEvent) => {
    let answer: Answer;
    try {
      if (event.pubkey !== remote.pubkey || event.kind !== NIP46_KIND) return;
      const { id, pubkey, kind, created_at, tags, content, sig } = event;
      if (!verifyEvent({ id, pubkey, kind, created_at, tags, content, sig } as Parameters<typeof verifyEvent>[0])) return;
      answer = JSON.parse(decrypt(event.content, key)) as Answer;
    } catch {
      return;
    }
    if (!answer || typeof answer.id !== 'string') return;
    const pending = waiting.get(answer.id);
    if (!pending) return;
    // The signer asks its user to approve at a page; the answer comes later.
    if (answer.result === 'auth_url') return;
    waiting.delete(answer.id);
    if (typeof answer.error === 'string' && answer.error) pending.reject(new Error(`the signer refused: ${answer.error}`));
    else pending.resolve(typeof answer.result === 'string' ? answer.result : '');
  };
  const sub = pool.subscribeMany(remote.relays, { kinds: [NIP46_KIND], '#p': [client], limit: 0 }, { onevent: onevent as (event: never) => void, oneose: () => ready() });
  await Promise.race([subscribed, new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS))]);

  return {
    request(method, params) {
      const id = randomBytes(8).toString('hex');
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`the signer did not answer (${method})`));
        }, timeoutMs);
        waiting.set(id, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        const event = finalizeEvent({
          kind: NIP46_KIND,
          tags: [['p', remote.pubkey]],
          content: encrypt(JSON.stringify({ id, method, params }), key),
          created_at: Math.floor(Date.now() / 1000),
        }, clientSecret);
        Promise.any(pool.publish(remote.relays, event)).catch(() => {
          // No relay took the request: it cannot be answered.
          const pending = waiting.get(id);
          waiting.delete(id);
          pending?.reject(new Error(`the signer's relays did not take the request (${method})`));
        });
      });
    },
    close() {
      for (const pending of waiting.values()) pending.reject(new Error('closed'));
      waiting.clear();
      sub.close();
    },
  };
}
