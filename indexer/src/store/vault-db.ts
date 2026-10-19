// vault.db: one random key per calendar entry, encrypted at rest with
// XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from the calendar-key
// secret. The entry's `d` is the associated data, so a ciphertext copied to
// another row does not decrypt. The file is never dumped; keys leave it only
// as a signature.
//
// It also keeps, for a calendar its organizer has the index publish as them,
// the connection to their remote signer (NIP-46), sealed the same way under a
// key of its own; and it opens what organizers seal to its intake key.

import Database from 'better-sqlite3';
import { hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { unsealWith } from '../claim/seal.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendar_keys (
  d TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL UNIQUE,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signer_connections (
  d TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;
const INFO = 'event-index/calendar-key/v1';
const CONNECTION_INFO = 'event-index/signer-connection/v1';
const INTAKE_INFO = 'event-index/intake/v1';

// How the index reaches an organizer's remote signer (NIP-46): its own client
// key, and the signer's key, relays and connection secret.
export interface SignerConnection {
  clientSecret: string;
  bunker: { pubkey: string; relays: string[]; secret: string | null };
}

export interface Vault {
  // The SQLite handle.
  raw: Database.Database;
  // Creates the entry's key on first call; returns its public key.
  createKey(d: string): string;
  pubkeyFor(d: string): string | null;
  sign(d: string, template: EventTemplate): VerifiedEvent;
  // Deletes the key (after a removal or a claim).
  forget(d: string): void;
  saveConnection(d: string, owner: string, connection: SignerConnection): void;
  connection(d: string): (SignerConnection & { owner: string }) | null;
  forgetConnection(d: string): void;
  // The key organizers seal to (claim/seal.ts), and opening what they sealed.
  intakePubkey: string;
  unseal(sealed: string): string;
  close(): void;
}

export function openVault(path: string, secret: Uint8Array): Vault {
  if (secret.length !== 32) throw new Error('the calendar-key secret must be 32 bytes');
  const key = new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), INFO, 32));
  const connectionKey = new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), CONNECTION_INFO, 32));
  const intakeSecret = new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), INTAKE_INFO, 32));
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const select = db.prepare<[string], { pubkey: string; nonce: Buffer; ciphertext: Buffer }>('SELECT pubkey, nonce, ciphertext FROM calendar_keys WHERE d = ?');
  const insert = db.prepare('INSERT INTO calendar_keys (d, pubkey, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)');
  const remove = db.prepare('DELETE FROM calendar_keys WHERE d = ?');
  const aad = (d: string) => new TextEncoder().encode(d);

  const withKey = <T>(d: string, use: (sk: Uint8Array) => T): T => {
    const row = select.get(d);
    if (!row) throw new Error(`no key for ${d}`);
    const sk = xchacha20poly1305(key, new Uint8Array(row.nonce), aad(d)).decrypt(new Uint8Array(row.ciphertext));
    try {
      if (getPublicKey(sk) !== row.pubkey) throw new Error(`key mismatch for ${d}`);
      return use(sk);
    } finally {
      sk.fill(0);
    }
  };

  const create = db.transaction((d: string): string => {
    const existing = select.get(d);
    if (existing) return existing.pubkey;
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const nonce = new Uint8Array(randomBytes(24));
    const ciphertext = xchacha20poly1305(key, nonce, aad(d)).encrypt(sk);
    sk.fill(0);
    insert.run(d, pubkey, Buffer.from(nonce), Buffer.from(ciphertext), Math.floor(Date.now() / 1000));
    return pubkey;
  });

  const selectConnection = db.prepare<[string], { owner: string; nonce: Buffer; ciphertext: Buffer }>('SELECT owner, nonce, ciphertext FROM signer_connections WHERE d = ?');
  const upsertConnection = db.prepare(`INSERT INTO signer_connections (d, owner, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (d) DO UPDATE SET owner = excluded.owner, nonce = excluded.nonce, ciphertext = excluded.ciphertext, created_at = excluded.created_at`);
  // The owner is sealed in with the connection, so a row cannot be given to
  // another owner either.
  const connectionAad = (d: string, owner: string) => new TextEncoder().encode(`${d}\u0000${owner}`);

  return {
    raw: db,
    // Reads, then writes: the write lock is taken first (see nostr-events.ts).
    createKey: (d) => create.immediate(d),
    pubkeyFor: (d) => select.get(d)?.pubkey ?? null,
    sign: (d, template) => withKey(d, (sk) => finalizeEvent(template, sk)),
    forget: (d) => void remove.run(d),
    saveConnection(d, owner, connection) {
      const nonce = new Uint8Array(randomBytes(24));
      const plain = new TextEncoder().encode(JSON.stringify(connection));
      const ciphertext = xchacha20poly1305(connectionKey, nonce, connectionAad(d, owner)).encrypt(plain);
      plain.fill(0);
      upsertConnection.run(d, owner, Buffer.from(nonce), Buffer.from(ciphertext), Math.floor(Date.now() / 1000));
    },
    connection(d) {
      const row = selectConnection.get(d);
      if (!row) return null;
      const plain = xchacha20poly1305(connectionKey, new Uint8Array(row.nonce), connectionAad(d, row.owner)).decrypt(new Uint8Array(row.ciphertext));
      try {
        return { owner: row.owner, ...(JSON.parse(new TextDecoder().decode(plain)) as SignerConnection) };
      } finally {
        plain.fill(0);
      }
    },
    forgetConnection: (d) => void db.prepare('DELETE FROM signer_connections WHERE d = ?').run(d),
    intakePubkey: getPublicKey(intakeSecret),
    unseal: (sealed) => unsealWith(intakeSecret, sealed),
    close: () => db.close(),
  };
}
