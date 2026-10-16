import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../src/config.ts';
import { acquireLock } from '../src/service/lock.ts';

test('settings come from the environment the deploy unit sets, with safe defaults', () => {
  const s = loadSettings({
    EVENTINDEX_DATA_DIR: '/var/lib/eventindex',
    EVENTINDEX_INDEX_KEY_FILE: '/etc/eventindex/index-key.nsec',
    EVENTINDEX_CALENDAR_SECRET_FILE: '/etc/eventindex/calendar-key.secret',
    EVENTINDEX_RELAY_URL: 'ws://127.0.0.1:7777',
    EVENTINDEX_PUBLIC_RELAY: 'wss://relay.eventindex.space',
    EVENTINDEX_API_PORT: '8080',
    EVENTINDEX_API_BASE: 'https://api.eventindex.space/api/1.0',
    EVENTINDEX_DOMAIN: 'eventindex.space',
  });
  assert.equal(s.indexDb, '/var/lib/eventindex/index.db');
  assert.equal(s.vaultDb, '/var/lib/eventindex/vault.db');
  assert.equal(s.dumpFile, '/var/lib/eventindex/dump/index.db');
  assert.equal(s.apiPort, 8080);
  assert.equal(s.publishToGeneralRelays, false);
  assert.deepEqual(s.generalRelays, ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io']);
  assert.deepEqual(s.listRelays, []);
  const on = loadSettings({ EVENTINDEX_DATA_DIR: '/d', EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_LIST_RELAYS: 'wss://a.example, wss://b.example' });
  assert.equal(on.publishToGeneralRelays, true);
  assert.deepEqual(on.listRelays, ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(s.searchRelays, []);
  assert.deepEqual(s.profileRelays, ['wss://purplepag.es']);
  const none = loadSettings({ EVENTINDEX_PROFILE_RELAYS: 'none', EVENTINDEX_SEARCH_RELAYS: 'wss://search.example' });
  assert.deepEqual(none.profileRelays, []);
  assert.deepEqual(none.searchRelays, ['wss://search.example']);
  assert.equal(s.directoryHeader, null);
  const header = `39998:${'ab'.repeat(32)}:event-calendars`;
  assert.equal(loadSettings({ EVENTINDEX_DIRECTORY_HEADER: header }).directoryHeader, header);
  assert.throws(() => loadSettings({ EVENTINDEX_DIRECTORY_HEADER: '39999:nope:x' }), /not a list header coordinate/);
});

test('ingestion reads the search relays unless told otherwise, and no search relay is named in the code', () => {
  assert.deepEqual(loadSettings({ EVENTINDEX_SEARCH_RELAYS: 'wss://search.example' }).ingestSearchRelays, ['wss://search.example']);
  assert.deepEqual(loadSettings({}).ingestSearchRelays, []);
  assert.deepEqual(loadSettings({ EVENTINDEX_SEARCH_RELAYS: 'wss://search.example', EVENTINDEX_INGEST_SEARCH_RELAYS: 'none' }).ingestSearchRelays, []);
  assert.deepEqual(loadSettings({ EVENTINDEX_INGEST_SEARCH_RELAYS: 'wss://other.example' }).ingestSearchRelays, ['wss://other.example']);
});

test('settings refuse a relay URL that is not ws or wss', () => {
  assert.throws(() => loadSettings({ EVENTINDEX_DATA_DIR: '/d', EVENTINDEX_RELAY_URL: 'http://x' }), /EVENTINDEX_RELAY_URL/);
});

test('one indexer at a time: the lock is held until released, and a dead holder\'s lock is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    const path = join(dir, 'indexer.lock');
    const lock = acquireLock(path);
    assert.throws(() => acquireLock(path), /held by process/);
    lock.release();
    assert.equal(existsSync(path), false);
    writeFileSync(path, '999999999\n');
    const again = acquireLock(path);
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
