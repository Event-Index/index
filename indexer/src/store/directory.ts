// The directory as this index keeps it: the entries it polls (filed by its
// own key), retired entries with their reason, the do-not-index list, and a
// few facts about the index itself.

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
  calendar_meta TEXT
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
}

export interface StoredEntry extends Entry {
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

interface Row {
  d: string; role: Role; source: Source; feed_url: string; page_url: string | null; name: string | null;
  description: string | null; image: string | null; location: string | null; g: string | null; found_via: string | null;
  pubkey: string | null; added_at: number; removed: string | null; removed_at: number | null;
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function directoryStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const toEntry = (row: Row | undefined): StoredEntry | null => (row
    ? {
      d: row.d, role: row.role, source: row.source, feedUrl: row.feed_url, pageUrl: row.page_url, name: row.name,
      description: row.description, image: row.image, location: row.location, g: row.g, foundVia: row.found_via,
      addedAt: row.added_at, pubkey: row.pubkey, removed: row.removed, removedAt: row.removed_at, localName: index.localNameFor(row.d),
    }
    : null);
  const byD = db.prepare<[string], Row>('SELECT * FROM directory WHERE d = ?');
  const blocked = db.prepare<[string], { d: string }>('SELECT d FROM do_not_index WHERE d = ?');
  const insert = db.prepare(`INSERT INTO directory (d, role, source, feed_url, page_url, name, description, image, location, g, found_via, added_at)
    VALUES (@d, @role, @source, @feedUrl, @pageUrl, @name, @description, @image, @location, @g, @foundVia, @addedAt)`);
  const block = db.prepare('INSERT OR IGNORE INTO do_not_index (d, reason, added_at) VALUES (?, ?, ?)');

  return {
    // False when the d is already listed or on the do-not-index list.
    add(entry: Entry): boolean {
      if (byD.get(entry.d) || blocked.get(entry.d)) return false;
      insert.run(entry);
      index.localNameFor(entry.d);
      return true;
    },
    get: (d: string) => toEntry(byD.get(d)),
    byFeedUrl: (url: string) => toEntry(db.prepare<[string], Row>('SELECT * FROM directory WHERE feed_url = ?').get(url)),
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
  };
}

export type DirectoryStore = ReturnType<typeof directoryStore>;
