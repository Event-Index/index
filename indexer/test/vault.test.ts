import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, hkdfSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { openVault } from '../src/store/vault-db.ts';
import { sealFor } from '../src/claim/seal.ts';

const secret = () => new Uint8Array(randomBytes(32));

test('the vault refuses a secret that is not 32 bytes', () => {
  assert.throws(() => openVault(':memory:', new Uint8Array(16)), /32 bytes/);
});

const CONNECTION = {
  clientSecret: 'cd'.repeat(32),
  bunker: { pubkey: 'ef'.repeat(32), relays: ['wss://bunker.example.org'], secret: 'one-time' },
};

test('a signer connection is kept sealed per calendar, and forgotten on request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  try {
    const path = join(dir, 'vault.db');
    const vault = openVault(path, secret());
    vault.saveConnection('meetup:pythonsd', 'a0'.repeat(32), CONNECTION);
    assert.deepEqual(vault.connection('meetup:pythonsd'), { owner: 'a0'.repeat(32), ...CONNECTION });
    assert.equal(vault.connection('meetup:other'), null);
    vault.close();
    const bytes = readFileSync(path);
    assert.equal(bytes.indexOf(Buffer.from(CONNECTION.clientSecret)), -1, 'the connection secret is not in the file in the clear');
    assert.equal(bytes.indexOf(Buffer.from('one-time')), -1);
    const again = openVault(path, secret());
    assert.throws(() => again.connection('meetup:pythonsd'), 'another secret cannot open it');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const vault = openVault(':memory:', secret());
  vault.saveConnection('meetup:pythonsd', 'a0'.repeat(32), CONNECTION);
  vault.forgetConnection('meetup:pythonsd');
  assert.equal(vault.connection('meetup:pythonsd'), null);
});

test('a connection copied to another calendar does not open', () => {
  const s = secret();
  const vault = openVault(':memory:', s);
  vault.saveConnection('meetup:a', 'a0'.repeat(32), CONNECTION);
  const raw = (vault as unknown as { raw: Database.Database }).raw;
  raw.prepare("UPDATE signer_connections SET d = 'meetup:b' WHERE d = 'meetup:a'").run();
  assert.throws(() => vault.connection('meetup:b'));
});

test('what an organizer hands the index for it is sealed to the vault\'s intake key and opened only there', () => {
  const vault = openVault(':memory:', secret());
  const sealed = sealFor(vault.intakePubkey, 'bunker://abc?relay=wss%3A%2F%2Fr.example.org&secret=s');
  assert.ok(!sealed.includes('bunker://'));
  assert.equal(vault.unseal(sealed), 'bunker://abc?relay=wss%3A%2F%2Fr.example.org&secret=s');
  const other = openVault(':memory:', secret());
  assert.throws(() => other.unseal(sealed));
  assert.match(vault.intakePubkey, /^[0-9a-f]{64}$/);
});

test('a signer connection is sealed under the signer secret, as spec/indexer-rules.md § 8 says', () => {
  const signer = secret();
  const vault = openVault(':memory:', signer);
  vault.saveConnection('meetup:a', 'a0'.repeat(32), CONNECTION);
  const row = vault.raw.prepare('SELECT nonce, ciphertext FROM signer_connections').get() as { nonce: Buffer; ciphertext: Buffer };
  const sealing = new Uint8Array(hkdfSync('sha256', signer, new Uint8Array(0), 'event-index/signer-connection/v1', 32));
  const plain = xchacha20poly1305(sealing, new Uint8Array(row.nonce), new TextEncoder().encode(`meetup:a\u0000${'a0'.repeat(32)}`)).decrypt(new Uint8Array(row.ciphertext));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), CONNECTION);
  // The intake key comes from the signer secret too.
  assert.equal(openVault(':memory:', signer).intakePubkey, vault.intakePubkey);
});

test('a vault from before holds no calendar key: the old table is dropped, and its ciphertexts are overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  try {
    const path = join(dir, 'vault.db');
    const old = new Database(path);
    old.exec('CREATE TABLE calendar_keys (d TEXT PRIMARY KEY, pubkey TEXT NOT NULL UNIQUE, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL)');
    const ciphertext = Buffer.from(randomBytes(48));
    old.prepare('INSERT INTO calendar_keys VALUES (?, ?, ?, ?, ?)').run('luma:cal-x', 'ab'.repeat(32), Buffer.from(randomBytes(24)), ciphertext, 1);
    old.close();
    const vault = openVault(path, secret());
    assert.equal((vault.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'calendar_keys'").get() as { n: number }).n, 0);
    vault.close();
    assert.equal(readFileSync(path).indexOf(ciphertext), -1, 'the old ciphertext is not in the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
