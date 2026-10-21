// What discovery found on aggregators' pages: each calendar it has seen and
// not yet filed, filed, skipped or refused, once. A skip keeps what the page
// showed of it (its event and hosts) for a maintainer's review; none of this
// is published or dumped.

import type { IndexDb } from './index-db.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discovered (
  d TEXT PRIMARY KEY,
  place TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS discovered_status ON discovered(status, first_at);
`;

// candidate: waiting for its feed to be checked; filed: in the directory;
// skipped: not an organization's public calendar, never filed by discovery;
// refused: its feed failed the checks, tried again when seen a day later.
export type FoundStatus = 'candidate' | 'filed' | 'skipped' | 'refused';

export interface FoundDetail {
  event?: string;
  url?: string;
  hosts?: string[];
  // For a calendar found on a listing page: the area it states.
  area?: { location: string; g: string | null };
}

export interface Found {
  d: string;
  // The aggregator whose page showed it.
  place: string;
  name: string | null;
  status: FoundStatus;
  reason: string | null;
  detail: FoundDetail | null;
  firstAt: number;
  lastAt: number;
  decidedAt: number | null;
}

interface Row {
  d: string; place: string; name: string | null; status: FoundStatus; reason: string | null; detail: string | null;
  first_at: number; last_at: number; decided_at: number | null;
}

const of = (r: Row): Found => ({
  d: r.d, place: r.place, name: r.name, status: r.status, reason: r.reason, detail: r.detail ? JSON.parse(r.detail) as FoundDetail : null,
  firstAt: r.first_at, lastAt: r.last_at, decidedAt: r.decided_at,
});

export function discoveredStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  return {
    get(d: string): Found | null {
      const r = db.prepare<[string], Row>('SELECT * FROM discovered WHERE d = ?').get(d);
      return r ? of(r) : null;
    },
    record(f: { d: string; place: string; name: string | null; status: FoundStatus; reason?: string | null; detail?: FoundDetail | null; at: number }): void {
      const decided = f.status === 'candidate' ? null : f.at;
      db.prepare(`INSERT INTO discovered (d, place, name, status, reason, detail, first_at, last_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (d) DO UPDATE SET status = excluded.status, reason = excluded.reason, last_at = excluded.last_at, decided_at = excluded.decided_at`)
        .run(f.d, f.place, f.name, f.status, f.reason ?? null, f.detail ? JSON.stringify(f.detail) : null, f.at, f.at, decided);
    },
    seen: (d: string, at: number) => void db.prepare('UPDATE discovered SET last_at = ? WHERE d = ?').run(at, d),
    decide(d: string, status: FoundStatus, reason: string | null, at: number, name?: string | null): void {
      db.prepare('UPDATE discovered SET status = ?, reason = ?, decided_at = ?, last_at = max(last_at, ?), name = coalesce(?, name) WHERE d = ?')
        .run(status, reason, at, at, name ?? null, d);
    },
    // Waiting calendars, the longest waiting first.
    candidates: (limit: number) => db.prepare<[number], Row>("SELECT * FROM discovered WHERE status = 'candidate' ORDER BY first_at, d LIMIT ?").all(limit).map(of),
    filedSince: (at: number) => db.prepare<[number], { n: number }>("SELECT count(*) AS n FROM discovered WHERE status = 'filed' AND decided_at >= ?").get(at)!.n,
    // Everything first seen, filed, skipped or refused since a time.
    since: (at: number) => db.prepare<[number, number], Row>('SELECT * FROM discovered WHERE first_at >= ? OR decided_at >= ? ORDER BY place, status, d')
      .all(at, at).map(of),
  };
}

export type DiscoveredStore = ReturnType<typeof discoveredStore>;
