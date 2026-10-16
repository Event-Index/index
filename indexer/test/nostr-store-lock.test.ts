import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { openIndexDb } from '../src/store/index-db.ts';
import { nostrStore } from '../src/store/nostr-events.ts';
import type { Found } from '../src/native/record.ts';
import { NOW } from './helpers.ts';

// Another process (the API, the backup) may commit while the poll service
// stores what it read. Storing an event reads before it writes: it must hold
// the write lock from the start, or such a commit in between fails it.
test('storing an event is not failed by another connection\'s commit between its read and its write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nostr-lock-'));
  try {
    const index = openIndexDb(join(dir, 'index.db'));
    const store = nostrStore(index);
    const other = openIndexDb(join(dir, 'index.db'));
    other.raw.pragma('busy_timeout = 0');
    other.raw.exec('CREATE TABLE IF NOT EXISTS elsewhere (n INTEGER)');
    const event = finalizeEvent({ kind: 31923, created_at: NOW, tags: [['d', 'x'], ['title', 'T'], ['start', String(NOW + 3600)]], content: '' }, generateSecretKey());
    let committed: boolean | null = null;
    // The relay is read when the event is written, after the store's reads.
    const found = {
      event,
      get relay() {
        try {
          other.raw.prepare('INSERT INTO elsewhere (n) VALUES (1)').run();
          committed = true;
        } catch {
          committed = false;
        }
        return 'wss://relay.test';
      },
    } as Found;
    assert.equal(store.put(found, NOW), 'new');
    assert.equal(committed, false, 'the other connection waited for the write lock');
    other.close();
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
