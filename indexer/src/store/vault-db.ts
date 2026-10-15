// vault.db: one random key per calendar entry, encrypted at rest with
// XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from the calendar-key
// secret. The entry's `d` is the associated data, so a ciphertext copied to
// another row does not decrypt. The file is never dumped; keys leave it only
// as a signature, or as NIP-49 `ncryptsec` when a claim hands one over.

import Database from 'better-sqlite3';
import { hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { encrypt as nip49Encrypt } from 'nostr-tools/nip49';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendar_keys (
  d TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL UNIQUE,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;
const INFO = 'event-index/calendar-key/v1';

export interface Vault {
  // Creates the entry's key on first call; returns its public key.
  createKey(d: string): string;
  pubkeyFor(d: string): string | null;
  sign(d: string, template: EventTemplate): VerifiedEvent;
  // NIP-49, for handing a key to its organizer.
  exportNcryptsec(d: string, password: string, logn?: number): string;
  // Deletes the key (after a hand-over, or a removal).
  forget(d: string): void;
  close(): void;
}

export function openVault(path: string, secret: Uint8Array): Vault {
  if (secret.length !== 32) throw new Error('the calendar-key secret must be 32 bytes');
  const key = new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), INFO, 32));
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

  return {
    createKey: (d) => create(d),
    pubkeyFor: (d) => select.get(d)?.pubkey ?? null,
    sign: (d, template) => withKey(d, (sk) => finalizeEvent(template, sk)),
    exportNcryptsec: (d, password, logn = 16) => withKey(d, (sk) => nip49Encrypt(sk, password, logn, 0x02)),
    forget: (d) => void remove.run(d),
    close: () => db.close(),
  };
}
