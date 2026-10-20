// The NIP-52 events the index has read from relays, kept as their publishers
// signed them: the newest version of each address (later created_at, then
// the lower id), with the publisher's own deletions honored. A publisher
// whose events change waits here until its records are built again. The
// index never signs or sends these events: they already live on nostr.

import type { IndexDb } from './index-db.ts';
import type { Found, NostrEvent } from '../native/record.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nostr_events (
  address TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  relay TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nostr_events_pubkey ON nostr_events(pubkey);
CREATE INDEX IF NOT EXISTS nostr_events_id ON nostr_events(id);
CREATE TABLE IF NOT EXISTS nostr_deletions (
  address TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nostr_dirty (
  pubkey TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nostr_profiles (
  pubkey TEXT PRIMARY KEY,
  name TEXT,
  about TEXT,
  picture TEXT,
  website TEXT,
  created_at INTEGER,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nostr_cursors (
  relay TEXT NOT NULL,
  stream TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (relay, stream)
);
`;

export type PutResult = 'new' | 'newer' | 'same' | 'older' | 'deleted';

export interface StoredNostrEvent {
  event: NostrEvent;
  relay: string | null;
}

// Where a relay's reading stands: going back through its history
// (`backfill`, below `until`), or keeping up (`sync`, from `newest`).
export interface Cursor {
  phase: 'backfill' | 'sync';
  until: number | null;
  newest: number;
  syncedAt: number;
  backfilledAt: number;
}

export interface NostrProfile {
  name: string | null;
  about: string | null;
  picture: string | null;
  website: string | null;
  createdAt: number | null;
}

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];
export const addressOf = (event: NostrEvent) => `${event.kind}:${event.pubkey}:${tag(event, 'd') ?? ''}`;

export function nostrStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const get = db.prepare<[string], { id: string; created_at: number }>('SELECT id, created_at FROM nostr_events WHERE address = ?');
  const upsert = db.prepare(`INSERT INTO nostr_events (address, pubkey, kind, id, created_at, event, relay, seen_at) VALUES (@address, @pubkey, @kind, @id, @created_at, @event, @relay, @seen_at)
    ON CONFLICT (address) DO UPDATE SET id = excluded.id, created_at = excluded.created_at, event = excluded.event, seen_at = excluded.seen_at`);
  const tombstone = db.prepare<[string], { created_at: number; pubkey: string }>('SELECT created_at, pubkey FROM nostr_deletions WHERE address = ?');
  const markDirty = db.prepare('INSERT INTO nostr_dirty (pubkey, since) VALUES (?, ?) ON CONFLICT (pubkey) DO NOTHING');

  const put = db.transaction((found: Found, now: number): PutResult => {
    const { event } = found;
    const address = addressOf(event);
    const deleted = tombstone.get(address);
    if (deleted && deleted.created_at >= event.created_at) return 'deleted';
    if (tombstone.get(`id:${event.id}:${event.pubkey}`)) return 'deleted';
    const known = get.get(address);
    if (known) {
      if (known.id === event.id) return 'same';
      const older = known.created_at > event.created_at || (known.created_at === event.created_at && known.id < event.id);
      if (older) return 'older';
    }
    const { id, pubkey, kind, created_at, tags, content, sig } = event;
    upsert.run({ address, pubkey, kind, id, created_at, event: JSON.stringify({ id, pubkey, created_at, kind, tags, content, sig }), relay: found.relay, seen_at: now });
    markDirty.run(pubkey, now);
    return known ? 'newer' : 'new';
  });

  // A deletion (kind 5) by its author: each `e` it names, and each `a` of
  // theirs, is removed when no newer than the deletion. Returns how many
  // stored events it removed; an `a` not stored yet is remembered.
  const applyDeletion = db.transaction((deletion: NostrEvent, now: number): number => {
    let removed = 0;
    for (const [name, value] of deletion.tags) {
      if (name === 'e' && value) {
        const row = db.prepare<[string, string], { address: string }>('SELECT address FROM nostr_events WHERE id = ? AND pubkey = ?').get(value, deletion.pubkey);
        if (row) removed += db.prepare('DELETE FROM nostr_events WHERE address = ?').run(row.address).changes;
        // Remembered by id, so the same event read again stays deleted.
        db.prepare('INSERT OR IGNORE INTO nostr_deletions (address, pubkey, created_at) VALUES (?, ?, ?)').run(`id:${value}:${deletion.pubkey}`, deletion.pubkey, deletion.created_at);
      } else if (name === 'a' && value && value.split(':')[1] === deletion.pubkey) {
        removed += db.prepare('DELETE FROM nostr_events WHERE address = ? AND created_at <= ?').run(value, deletion.created_at).changes;
        db.prepare(`INSERT INTO nostr_deletions (address, pubkey, created_at) VALUES (?, ?, ?)
          ON CONFLICT (address) DO UPDATE SET created_at = max(created_at, excluded.created_at)`).run(value, deletion.pubkey, deletion.created_at);
      }
    }
    if (removed) markDirty.run(deletion.pubkey, now);
    return removed;
  });

  return {
    // Each reads, then writes: it takes the write lock first (BEGIN IMMEDIATE),
    // so a commit by another process in between cannot fail it.
    put: (found: Found, now: number) => put.immediate(found, now),
    applyDeletion: (deletion: NostrEvent, now: number) => applyDeletion.immediate(deletion, now),
    eventsOf: (pubkey: string): StoredNostrEvent[] => db.prepare<[string], { event: string; relay: string | null }>(
      'SELECT event, relay FROM nostr_events WHERE pubkey = ? ORDER BY address',
    ).all(pubkey).map((r) => ({ event: JSON.parse(r.event) as NostrEvent, relay: r.relay })),
    // Every key with an event kept.
    publishers: () => db.prepare<[], { pubkey: string }>('SELECT DISTINCT pubkey FROM nostr_events ORDER BY pubkey').all().map((r) => r.pubkey),
    // Where an address's event was first read, and its version's created_at.
    seen: (address: string): { relay: string | null; createdAt: number } | null => {
      const row = db.prepare<[string], { relay: string | null; created_at: number }>('SELECT relay, created_at FROM nostr_events WHERE address = ?').get(address);
      return row ? { relay: row.relay, createdAt: row.created_at } : null;
    },
    count: () => db.prepare<[], { n: number }>('SELECT count(*) AS n FROM nostr_events').get()!.n,
    // Publishers whose records wait to be built, the longest waiting first.
    dirty: (limit: number) => db.prepare<[number], { pubkey: string }>('SELECT pubkey FROM nostr_dirty ORDER BY since, pubkey LIMIT ?').all(limit).map((r) => r.pubkey),
    markDirty: (pubkey: string, now: number) => void markDirty.run(pubkey, now),
    built: (pubkey: string) => void db.prepare('DELETE FROM nostr_dirty WHERE pubkey = ?').run(pubkey),
    // Drops a publisher's events (its calendar was removed).
    forget(pubkey: string): void {
      db.prepare('DELETE FROM nostr_events WHERE pubkey = ?').run(pubkey);
      db.prepare('DELETE FROM nostr_dirty WHERE pubkey = ?').run(pubkey);
    },
    cursor(relay: string, stream: string): Cursor | null {
      const row = db.prepare<[string, string], { state: string }>('SELECT state FROM nostr_cursors WHERE relay = ? AND stream = ?').get(relay, stream);
      return row ? (JSON.parse(row.state) as Cursor) : null;
    },
    setCursor: (relay: string, stream: string, cursor: Cursor) => void db.prepare(`INSERT INTO nostr_cursors (relay, stream, state) VALUES (?, ?, ?)
      ON CONFLICT (relay, stream) DO UPDATE SET state = excluded.state`).run(relay, stream, JSON.stringify(cursor)),
    profile(pubkey: string): (NostrProfile & { checkedAt: number }) | null {
      const r = db.prepare<[string], { name: string | null; about: string | null; picture: string | null; website: string | null; created_at: number | null; checked_at: number }>(
        'SELECT name, about, picture, website, created_at, checked_at FROM nostr_profiles WHERE pubkey = ?',
      ).get(pubkey);
      return r ? { name: r.name, about: r.about, picture: r.picture, website: r.website, createdAt: r.created_at, checkedAt: r.checked_at } : null;
    },
    setProfile: (pubkey: string, p: NostrProfile, now: number) => void db.prepare(`INSERT INTO nostr_profiles (pubkey, name, about, picture, website, created_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name, about = excluded.about, picture = excluded.picture,
      website = excluded.website, created_at = excluded.created_at, checked_at = excluded.checked_at`).run(pubkey, p.name, p.about, p.picture, p.website, p.createdAt, now),
    // Records a profile check that found nothing newer.
    checkedProfile: (pubkey: string, now: number) => void db.prepare(`INSERT INTO nostr_profiles (pubkey, checked_at) VALUES (?, ?)
      ON CONFLICT (pubkey) DO UPDATE SET checked_at = excluded.checked_at`).run(pubkey, now),
  };
}

export type NostrStore = ReturnType<typeof nostrStore>;
