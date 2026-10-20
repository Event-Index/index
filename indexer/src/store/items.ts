// The event items the index key has published (spec/event-items.md): which
// calendar each belongs to, when its event ends and its item expires, and
// since when it has been missing from its calendar. Their versions and
// hashes are kept with the other projections (index-db.ts). An item past its
// expiration is kept as expired, with the deletion the list relays are owed
// for it, signed once and sent until taken.

import type { IndexDb } from './index-db.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_items (
  d TEXT PRIMARY KEY,
  calendar_d TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  missing_since INTEGER
);
CREATE INDEX IF NOT EXISTS event_items_calendar ON event_items(calendar_d);
CREATE TABLE IF NOT EXISTS expired_items (
  d TEXT PRIMARY KEY,
  calendar_d TEXT NOT NULL,
  expired_at INTEGER NOT NULL,
  deletion TEXT
);
CREATE TABLE IF NOT EXISTS expiry_deletions (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  taken_at INTEGER
);
`;

export interface LiveItem {
  d: string;
  calendarD: string;
  endsAt: number;
  expiresAt: number;
  missingSince: number | null;
}

interface Row { d: string; calendar_d: string; ends_at: number; expires_at: number; missing_since: number | null }
const of = (r: Row): LiveItem => ({ d: r.d, calendarD: r.calendar_d, endsAt: r.ends_at, expiresAt: r.expires_at, missingSince: r.missing_since });

export function itemStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  return {
    put: (item: { d: string; calendarD: string; endsAt: number; expiresAt: number }) => void db.prepare(`INSERT INTO event_items (d, calendar_d, ends_at, expires_at, missing_since)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT (d) DO UPDATE SET calendar_d = excluded.calendar_d, ends_at = excluded.ends_at, expires_at = excluded.expires_at, missing_since = NULL`)
      .run(item.d, item.calendarD, item.endsAt, item.expiresAt),
    all: () => db.prepare<[], Row>('SELECT * FROM event_items ORDER BY d').all().map(of),
    present: (d: string) => void db.prepare('UPDATE event_items SET missing_since = NULL WHERE d = ?').run(d),
    missing: (d: string, since: number) => void db.prepare('UPDATE event_items SET missing_since = coalesce(missing_since, ?) WHERE d = ?').run(since, d),
    forget: (d: string) => void db.prepare('DELETE FROM event_items WHERE d = ?').run(d),
    has: (d: string) => !!db.prepare<[string], { d: string }>('SELECT d FROM event_items WHERE d = ?').get(d),
    count: () => db.prepare<[], { n: number }>('SELECT count(*) AS n FROM event_items').get()!.n,
    // Past its expiration: no longer live, and owed a deletion.
    expire: db.transaction((item: { d: string; calendarD: string }, at: number) => {
      db.prepare('DELETE FROM event_items WHERE d = ?').run(item.d);
      db.prepare(`INSERT INTO expired_items (d, calendar_d, expired_at, deletion) VALUES (?, ?, ?, NULL)
        ON CONFLICT (d) DO UPDATE SET calendar_d = excluded.calendar_d, expired_at = excluded.expired_at, deletion = NULL`).run(item.d, item.calendarD, at);
    }),
    // Expired items no deletion has been signed for yet, oldest first.
    undeleted: () => db.prepare<[], { d: string }>('SELECT d FROM expired_items WHERE deletion IS NULL ORDER BY expired_at, d').all().map((r) => r.d),
    addDeletion: db.transaction((event: { id: string; created_at: number }, ds: string[]) => {
      db.prepare('INSERT INTO expiry_deletions (id, event, created_at, taken_at) VALUES (?, ?, ?, NULL)').run(event.id, JSON.stringify(event), event.created_at);
      const mark = db.prepare('UPDATE expired_items SET deletion = ? WHERE d = ?');
      for (const d of ds) mark.run(event.id, d);
    }),
    // Deletions the list relays have not taken yet.
    owed: <E>(): E[] => db.prepare<[], { event: string }>('SELECT event FROM expiry_deletions WHERE taken_at IS NULL ORDER BY created_at, id').all().map((r) => JSON.parse(r.event) as E),
    taken: (id: string, at: number) => void db.prepare('UPDATE expiry_deletions SET taken_at = ? WHERE id = ?').run(at, id),
  };
}

export type ItemStore = ReturnType<typeof itemStore>;
