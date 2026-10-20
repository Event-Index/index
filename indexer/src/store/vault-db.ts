// vault.db: for a calendar its organizer has the index publish as them, the
// connection to their remote signer (NIP-46), encrypted at rest with
// XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from the signer
// secret, with the entry's `d` and the organizer's key as associated data, so
// a ciphertext copied to another row or owner does not decrypt. It also opens
// what organizers seal to its intake key, derived from the signer secret too.
// The file is never dumped. The index holds no calendar key
// (spec/indexer-rules.md § 8).

import Database from 'better-sqlite3';
import { hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { getPublicKey } from 'nostr-tools/pure';
import { unsealWith } from '../claim/seal.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signer_connections (
  d TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;
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
  saveConnection(d: string, owner: string, connection: SignerConnection): void;
  connection(d: string): (SignerConnection & { owner: string }) | null;
  forgetConnection(d: string): void;
  // The key organizers seal to (claim/seal.ts), and opening what they sealed.
  intakePubkey: string;
  unseal(sealed: string): string;
  close(): void;
}

const derive = (secret: Uint8Array, info: string) => new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), info, 32));

export function openVault(path: string, signerSecret: Uint8Array): Vault {
  if (signerSecret.length !== 32) throw new Error('the signer secret must be 32 bytes');
  const connectionKey = derive(signerSecret, CONNECTION_INFO);
  const intakeSecret = derive(signerSecret, INTAKE_INFO);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // A vault from before the calendar keys were destroyed holds ciphertexts
  // that no secret opens any more.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calendar_keys'").get()) {
    db.pragma('secure_delete = ON');
    db.exec('DROP TABLE calendar_keys');
    db.exec('VACUUM');
  }

  const selectConnection = db.prepare<[string], { owner: string; nonce: Buffer; ciphertext: Buffer }>('SELECT owner, nonce, ciphertext FROM signer_connections WHERE d = ?');
  const upsertConnection = db.prepare(`INSERT INTO signer_connections (d, owner, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (d) DO UPDATE SET owner = excluded.owner, nonce = excluded.nonce, ciphertext = excluded.ciphertext, created_at = excluded.created_at`);
  // The owner is sealed in with the connection, so a row cannot be given to
  // another owner either.
  const connectionAad = (d: string, owner: string) => new TextEncoder().encode(`${d}\u0000${owner}`);

  return {
    raw: db,
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
