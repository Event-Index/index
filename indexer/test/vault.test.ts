import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { verifyEvent, getPublicKey } from 'nostr-tools/pure';
import { decrypt as nip49Decrypt } from 'nostr-tools/nip49';
import { openVault } from '../src/store/vault-db.ts';

const secret = () => new Uint8Array(randomBytes(32));

test('a calendar key is created once per d and signs for it', () => {
  const vault = openVault(':memory:', secret());
  const pubkey = vault.createKey('luma:cal-x');
  assert.match(pubkey, /^[0-9a-f]{64}$/);
  assert.equal(vault.createKey('luma:cal-x'), pubkey);
  assert.equal(vault.pubkeyFor('luma:cal-x'), pubkey);
  assert.notEqual(vault.createKey('luma:cal-y'), pubkey);
  const event = vault.sign('luma:cal-x', { kind: 1, created_at: 1, tags: [], content: 'x' });
  assert.equal(event.pubkey, pubkey);
  assert.ok(verifyEvent(event));
});

test('the vault file holds no key in the clear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  try {
    const path = join(dir, 'vault.db');
    const vault = openVault(path, secret());
    vault.createKey('meetup:pythonsd');
    const exported = nip49Decrypt(vault.exportNcryptsec('meetup:pythonsd', 'correct horse', 4), 'correct horse');
    vault.close();
    const bytes = readFileSync(path);
    assert.equal(bytes.indexOf(Buffer.from(exported)), -1);
    assert.equal(bytes.indexOf(Buffer.from(Buffer.from(exported).toString('hex'))), -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key cannot be read with another secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  try {
    const path = join(dir, 'vault.db');
    const first = openVault(path, secret());
    first.createKey('meetup:pythonsd');
    first.close();
    const other = openVault(path, secret());
    assert.throws(() => other.sign('meetup:pythonsd', { kind: 1, created_at: 1, tags: [], content: '' }));
    other.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key moved to another calendar\'s row does not decrypt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  try {
    const path = join(dir, 'vault.db');
    const key = secret();
    const vault = openVault(path, key);
    vault.createKey('a');
    vault.createKey('b');
    vault.close();
    const raw = new Database(path);
    const rows = raw.prepare('SELECT d, nonce, ciphertext FROM calendar_keys ORDER BY d').all() as Array<{ d: string; nonce: Buffer; ciphertext: Buffer }>;
    const update = raw.prepare('UPDATE calendar_keys SET nonce = ?, ciphertext = ? WHERE d = ?');
    update.run(rows[1]!.nonce, rows[1]!.ciphertext, 'a');
    update.run(rows[0]!.nonce, rows[0]!.ciphertext, 'b');
    raw.close();
    const reopened = openVault(path, key);
    assert.throws(() => reopened.sign('a', { kind: 1, created_at: 1, tags: [], content: '' }));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key exports as ncryptsec and can then be forgotten', () => {
  const vault = openVault(':memory:', secret());
  const pubkey = vault.createKey('mobilizon:mobilizon.fr/@lyontechhub');
  const ncryptsec = vault.exportNcryptsec('mobilizon:mobilizon.fr/@lyontechhub', 'organizer password', 4);
  assert.match(ncryptsec, /^ncryptsec1/);
  assert.equal(getPublicKey(nip49Decrypt(ncryptsec, 'organizer password')), pubkey);
  vault.forget('mobilizon:mobilizon.fr/@lyontechhub');
  assert.equal(vault.pubkeyFor('mobilizon:mobilizon.fr/@lyontechhub'), null);
});

test('the vault refuses a secret that is not 32 bytes', () => {
  assert.throws(() => openVault(':memory:', new Uint8Array(16)), /32 bytes/);
});
