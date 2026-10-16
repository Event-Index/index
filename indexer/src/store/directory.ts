// The directory as this index keeps it: the entries it polls (filed by its
// own key), retired entries with their reason, the do-not-index list, and a
// few facts about the index itself.
//
// An entry is `mirrored` (its feed is read, and the calendar key the index
// holds signs its events), `own` (its organizer publishes from their own key,
// and the index reads their events), or `delegated` (its feed is read, and the
// index signs its events with its organizer's key, through a signer they
// connected).

import type { IndexDb } from './index-db.ts';
import type { Role, Source } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS directory (
  d TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  page_url TEXT,
  name TEXT,
  description TEXT,
  image TEXT,
  location TEXT,
  g TEXT,
  found_via TEXT,
  pubkey TEXT UNIQUE,
  added_at INTEGER NOT NULL,
  removed TEXT,
  removed_at INTEGER,
  calendar_meta TEXT,
  mode TEXT NOT NULL DEFAULT 'mirrored',
  owner TEXT,
  claimed_at INTEGER,
  native_calendar TEXT,
  owner_relays TEXT
);
CREATE INDEX IF NOT EXISTS directory_feed ON directory(feed_url);
CREATE TABLE IF NOT EXISTS do_not_index (
  d TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Mode = 'mirrored' | 'own' | 'delegated';

// Columns added after the first release, for a directory created before.
const ADDED: Array<[string, string]> = [
  ['mode', "TEXT NOT NULL DEFAULT 'mirrored'"],
  ['owner', 'TEXT'],
  ['claimed_at', 'INTEGER'],
  ['native_calendar', 'TEXT'],
  ['owner_relays', 'TEXT'],
];

export interface Ownership {
  mode: Mode;
  // The organizer's own key.
  owner: string | null;
  claimedAt: number | null;
  // The kind 31924 the entry names in `calendar`.
  nativeCalendar: string | null;
}

export interface Entry {
  d: string;
  role: Role;
  source: Source;
  feedUrl: string;
  pageUrl: string | null;
  name: string | null;
  description: string | null;
  image: string | null;
  location: string | null;
  g: string | null;
  foundVia: string | null;
  addedAt: number;
  // Mirrored unless given.
  mode?: Mode;
  owner?: string | null;
}

export interface StoredEntry extends Omit<Entry, 'mode' | 'owner'>, Ownership {
  // The relays its organizer publishes to, as last read.
  ownerRelays: string[];
  pubkey: string | null;
  localName: string;
  removed: string | null;
  removedAt: number | null;
}

export interface CalendarFacts {
  name: string | null;
  description: string | null;
  url: string | null;
  image: string | null;
}

// The key a calendar's events are signed with now: the calendar key the
// index holds, or its organizer's own.
export function currentKey(entry: StoredEntry): string | null {
  return entry.mode === 'mirrored' ? entry.pubkey : entry.owner;
}

// Who may own what: a key that publishes a calendar itself owns no other
// listed calendar, since the index reads every event of that key as that
// calendar's; a key the index publishes as may have several such calendars.
// Returns the listed entry a key taking `d` in `mode` would clash with.
export function ownershipClash(owned: StoredEntry[], d: string, mode: 'own' | 'delegated'): StoredEntry | null {
  const others = owned.filter((e) => !e.removed && e.d !== d);
  return (mode === 'own' ? others[0] : others.find((e) => e.mode === 'own')) ?? null;
}

interface Row {
  d: string; role: Role; source: Source; feed_url: string; page_url: string | null; name: string | null;
  description: string | null; image: string | null; location: string | null; g: string | null; found_via: string | null;
  pubkey: string | null; added_at: number; removed: string | null; removed_at: number | null;
  mode: Mode; owner: string | null; claimed_at: number | null; native_calendar: string | null; owner_relays: string | null;
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function directoryStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const columns = new Set(db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('directory')").all().map((c) => c.name));
  for (const [name, type] of ADDED) if (!columns.has(name)) db.exec(`ALTER TABLE directory ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS directory_owner ON directory(owner)');
  const toEntry = (row: Row | undefined): StoredEntry | null => (row
    ? {
      d: row.d, role: row.role, source: row.source, feedUrl: row.feed_url, pageUrl: row.page_url, name: row.name,
      description: row.description, image: row.image, location: row.location, g: row.g, foundVia: row.found_via,
      addedAt: row.added_at, pubkey: row.pubkey, removed: row.removed, removedAt: row.removed_at, localName: index.localNameFor(row.d),
      mode: row.mode, owner: row.owner, claimedAt: row.claimed_at, nativeCalendar: row.native_calendar,
      ownerRelays: row.owner_relays ? (JSON.parse(row.owner_relays) as string[]) : [],
    }
    : null);
  const byD = db.prepare<[string], Row>('SELECT * FROM directory WHERE d = ?');
  const blocked = db.prepare<[string], { d: string }>('SELECT d FROM do_not_index WHERE d = ?');
  const insert = db.prepare(`INSERT INTO directory (d, role, source, feed_url, page_url, name, description, image, location, g, found_via, added_at, mode, owner)
    VALUES (@d, @role, @source, @feedUrl, @pageUrl, @name, @description, @image, @location, @g, @foundVia, @addedAt, @mode, @owner)`);
  const block = db.prepare('INSERT OR IGNORE INTO do_not_index (d, reason, added_at) VALUES (?, ?, ?)');

  return {
    // False when the d is already listed or on the do-not-index list.
    add(entry: Entry): boolean {
      if (byD.get(entry.d) || blocked.get(entry.d)) return false;
      insert.run({ ...entry, mode: entry.mode ?? 'mirrored', owner: entry.owner ?? null });
      index.localNameFor(entry.d);
      return true;
    },
    get: (d: string) => toEntry(byD.get(d)),
    byFeedUrl: (url: string) => (url ? toEntry(db.prepare<[string], Row>('SELECT * FROM directory WHERE feed_url = ?').get(url)) : null),
    // Entries an organizer's own key owns.
    byOwner: (pubkey: string) => db.prepare<[string], Row>('SELECT * FROM directory WHERE owner = ? ORDER BY d').all(pubkey).map((r) => toEntry(r)!),
    byLocalName(name: string): StoredEntry | null {
      const d = index.calendarForLocalName(name);
      return d ? toEntry(byD.get(d)) : null;
    },
    byPubkey: (pubkey: string) => toEntry(db.prepare<[string], Row>('SELECT * FROM directory WHERE pubkey = ?').get(pubkey)),
    list(options: { includeRemoved?: boolean } = {}): StoredEntry[] {
      const sql = options.includeRemoved ? 'SELECT * FROM directory ORDER BY d' : 'SELECT * FROM directory WHERE removed IS NULL ORDER BY d';
      return db.prepare<[], Row>(sql).all().map((r) => toEntry(r)!);
    },
    search(query: { q?: string; near?: string; tag?: string; limit?: number }): StoredEntry[] {
      const where = ['removed IS NULL'];
      const params: string[] = [];
      if (query.q) {
        where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')");
        params.push(like(query.q), like(query.q), like(query.q));
      }
      // Either area holds the other: a calendar's area is coarse.
      if (query.near) {
        where.push("(g LIKE ? ESCAPE '\\' OR ? LIKE g || '%')");
        params.push(`${query.near.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, query.near);
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
      return db.prepare<string[], Row>(`SELECT * FROM directory WHERE ${where.join(' AND ')} ORDER BY name, d LIMIT ${limit}`).all(...params).map((r) => toEntry(r)!);
    },
    setKey: (d: string, pubkey: string) => void db.prepare('UPDATE directory SET pubkey = ? WHERE d = ?').run(pubkey, d),
    setOwnership: (d: string, o: Ownership) => void db.prepare('UPDATE directory SET mode = ?, owner = ?, claimed_at = ?, native_calendar = ? WHERE d = ?')
      .run(o.mode, o.owner, o.claimedAt, o.nativeCalendar, d),
    setOwnerRelays: (d: string, relays: string[]) => void db.prepare('UPDATE directory SET owner_relays = ? WHERE d = ?').run(JSON.stringify(relays), d),
    setMeta(d: string, facts: CalendarFacts): void {
      db.prepare(`UPDATE directory SET name = coalesce(?, name), description = ?, page_url = coalesce(?, page_url), image = ? WHERE d = ?`)
        .run(facts.name, facts.description, facts.url, facts.image, d);
    },
    retire(d: string, reason: string, at: number): void {
      db.prepare('UPDATE directory SET removed = ?, removed_at = ? WHERE d = ?').run(reason, at, d);
      block.run(d, reason, at);
    },
    doNotIndex: (d: string) => !!blocked.get(d),
    block: (d: string, reason: string, at: number) => void block.run(d, reason, at),
    // The calendar's metadata as the last poll read it (normalize's CalendarMeta).
    setCalendarMeta: (d: string, meta: unknown) => void db.prepare('UPDATE directory SET calendar_meta = ? WHERE d = ?').run(JSON.stringify(meta), d),
    calendarMeta(d: string): unknown {
      const row = db.prepare<[string], { calendar_meta: string | null }>('SELECT calendar_meta FROM directory WHERE d = ?').get(d);
      return row?.calendar_meta ? JSON.parse(row.calendar_meta) : null;
    },
    setFact: (key: string, value: string) => void db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value),
    fact: (key: string) => db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    deleteFact: (key: string) => void db.prepare('DELETE FROM meta WHERE key = ?').run(key),
    factsWithPrefix: (prefix: string) => db.prepare<[string, string], { key: string; value: string }>('SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key')
      .all(prefix, `${prefix}\uffff`),
  };
}

export type DirectoryStore = ReturnType<typeof directoryStore>;
