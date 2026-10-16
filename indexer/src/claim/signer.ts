// Who signs a calendar's events: the calendar key in the vault, or, for a
// calendar its organizer has the index publish as them, their own key through
// their remote signer (NIP-46). The index asks a remote signer only for the
// kinds it publishes for a calendar (31922, 31923, 31924 and deletions), and
// checks every event it gets back.

import { generateSecretKey, verifyEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { BunkerSigner } from 'nostr-tools/nip46';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { BunkerPointer } from './proof.ts';
import type { SignerConnection, Vault } from '../store/vault-db.ts';

// The kinds the index signs as an organizer, and asks their signer for.
export const DELEGATED_KINDS = [31922, 31923, 31924, 5];
export const PERMISSIONS = DELEGATED_KINDS.map((k) => `sign_event:${k}`).join(',');
// How long a remote signer may take to answer one request.
export const SIGNER_TIMEOUT_MS = 30_000;

export type Template = EventTemplate & { created_at: number };

export interface Signer {
  pubkey: string;
  sign(template: Template): Promise<VerifiedEvent>;
}

export interface RemoteSession extends Signer {
  close(): Promise<void>;
}

export interface RemoteSigners {
  // A first connection, with the signer's one-time secret: the index makes a
  // client key of its own, asks for the permissions it needs, and learns
  // which key the signer signs as.
  pair(pointer: BunkerPointer, permissions: string): Promise<{ connection: SignerConnection; session: RemoteSession }>;
  // A connection made before.
  open(connection: SignerConnection): Promise<RemoteSession>;
}

export function vaultSigner(vault: Vault, d: string, pubkey: string): Signer {
  return { pubkey, sign: async (template) => vault.sign(d, template) };
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`the signer did not answer (${what})`)), ms); }),
  ]);
}

// A session that signs only the delegated kinds, and only what was asked:
// each event must be the template, signed by the organizer's key.
export function limited(session: RemoteSession, kinds = DELEGATED_KINDS): RemoteSession {
  return {
    pubkey: session.pubkey,
    async sign(template) {
      if (!kinds.includes(template.kind)) throw new Error(`kind ${template.kind} is not signed for an organizer`);
      const event = await session.sign(template);
      const { id, pubkey, kind, created_at, tags, content, sig } = event;
      const same = pubkey === session.pubkey && kind === template.kind && created_at === template.created_at && content === template.content
        && JSON.stringify(tags) === JSON.stringify(template.tags);
      if (!same || !verifyEvent({ id, pubkey, kind, created_at, tags, content, sig } as Parameters<typeof verifyEvent>[0])) {
        throw new Error('the signer returned another event');
      }
      return event;
    },
    close: () => session.close(),
  };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// Remote signers over NIP-46, through nostr-tools' BunkerSigner.
export function nip46Signers(pool?: AbstractSimplePool, timeoutMs = SIGNER_TIMEOUT_MS): RemoteSigners {
  async function session(bunker: BunkerSigner): Promise<RemoteSession> {
    const pubkey = await withTimeout(bunker.getPublicKey(), timeoutMs, 'get_public_key');
    return {
      pubkey,
      sign: (template) => withTimeout(bunker.signEvent(template), timeoutMs, `sign_event ${template.kind}`),
      close: () => bunker.close(),
    };
  }
  const params = pool ? { pool } : {};
  return {
    async pair(pointer, permissions) {
      const clientSecret = generateSecretKey();
      const bunker = BunkerSigner.fromBunker(clientSecret, { ...pointer }, params);
      try {
        await withTimeout(bunker.sendRequest('connect', [pointer.pubkey, pointer.secret ?? '', permissions]), timeoutMs, 'connect');
        const opened = await session(bunker);
        return { connection: { clientSecret: hex(clientSecret), bunker: { pubkey: pointer.pubkey, relays: pointer.relays, secret: null } }, session: opened };
      } catch (error) {
        await bunker.close().catch(() => {});
        throw error;
      }
    },
    async open(connection) {
      const clientSecret = new Uint8Array(Buffer.from(connection.clientSecret, 'hex'));
      const bunker = BunkerSigner.fromBunker(clientSecret, { pubkey: connection.bunker.pubkey, relays: connection.bunker.relays, secret: null }, params);
      try {
        return await session(bunker);
      } catch (error) {
        await bunker.close().catch(() => {});
        throw error;
      }
    },
  };
}
