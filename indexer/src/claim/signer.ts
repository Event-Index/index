// Who signs a calendar's events when its organizer has the index publish as
// them: their own key, through their remote signer (NIP-46). The index asks a remote signer only for the
// kinds it publishes for a calendar (31922, 31923, 31924 and deletions), and
// checks every event it gets back.

import { generateSecretKey, verifyEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { BunkerPointer } from './proof.ts';
import { openNip46, type Nip46Client, type Nip46Pool } from './nip46.ts';
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

// Remote signers over NIP-46, through the index's own client (nip46.ts).
export function nip46Signers(pool: Nip46Pool, timeoutMs = SIGNER_TIMEOUT_MS): RemoteSigners {
  async function session(client: Nip46Client): Promise<RemoteSession> {
    const pubkey = await client.request('get_public_key', []);
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('the signer gave no key');
    return {
      pubkey,
      sign: async (template) => JSON.parse(await client.request('sign_event', [JSON.stringify(template)])) as VerifiedEvent,
      close: async () => client.close(),
    };
  }
  return {
    async pair(pointer, permissions) {
      const clientSecret = generateSecretKey();
      const client = await openNip46(pool, clientSecret, pointer, timeoutMs);
      try {
        await client.request('connect', [pointer.pubkey, pointer.secret ?? '', permissions]);
        const opened = await session(client);
        return { connection: { clientSecret: hex(clientSecret), bunker: { pubkey: pointer.pubkey, relays: pointer.relays, secret: null } }, session: opened };
      } catch (error) {
        client.close();
        throw error;
      }
    },
    async open(connection) {
      const client = await openNip46(pool, new Uint8Array(Buffer.from(connection.clientSecret, 'hex')), connection.bunker, timeoutMs);
      try {
        return await session(client);
      } catch (error) {
        client.close();
        throw error;
      }
    },
  };
}
