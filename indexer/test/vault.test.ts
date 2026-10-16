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
import { sealFor } from '../src/claim/seal.ts';

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
