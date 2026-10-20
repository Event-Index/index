// index.db: records, projection hashes and versions, presence state and the
// calendars' local names. Past events live only here once their feeds drop
// them, so the file is history and is backed up as such. No secret is stored
// here.

import Database from 'better-sqlite3';
import { localName } from '../directory/id.ts';
import { emptyPresence, type PresenceState } from '../rules/presence.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  calendar_d TEXT NOT NULL,
  uid TEXT NOT NULL,
  ics TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  UNIQUE (calendar_d, uid)
);
CREATE TABLE IF NOT EXISTS projections (
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  d TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  start INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  template TEXT,
  PRIMARY KEY (pubkey, kind, d)
);
CREATE TABLE IF NOT EXISTS versions (
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  d TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, kind, d, event_id)
);
CREATE TABLE IF NOT EXISTS presence (
  calendar_d TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_state (
  calendar_d TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_names (
  name TEXT PRIMARY KEY,
  calendar_d TEXT NOT NULL UNIQUE
);
`;

export interface Published {
  pubkey: string;
  kind: number;
  d: string;
  hash: string;
  eventId: string;
  createdAt: number;
  start: number;
  // The unsigned event, kept so a withdrawn event can be republished as
  // cancelled.
  template?: unknown;
}

export interface PollState {
  etag: string | null;
  lastModified: string | null;
  failures: number;
  firstFailureAt: number | null;
  lastSuccessAt: number | null;
  nextPollAt: number;
  stale: boolean;
  // From the last successful parse, so a 304 keeps the same schedule.
  refreshInterval?: number | null;
  nextEventStart?: number | null;
}

export const NEW_POLL_STATE: PollState = {
  etag: null, lastModified: null, failures: 0, firstFailureAt: null, lastSuccessAt: null, nextPollAt: 0, stale: false,
};

export interface ProjectionRow {
  hash: string;
  createdAt: number;
  start: number;
  status: 'live' | 'cancelled' | 'deleted';
}

export interface IndexDb {
  // The SQLite handle, for the other stores that share the file.
  raw: Database.Database;
  shouldPublish(pubkey: string, kind: number, d: string, hash: string): boolean;
  markPublished(p: Published): void;
  markWithdrawn(pubkey: string, kind: number, d: string, status: 'cancelled' | 'deleted'): void;
  projection(pubkey: string, kind: number, d: string): ProjectionRow | null;
  versions(pubkey: string, kind: number, d: string): string[];
  lastCreatedAt(pubkey: string, kind: number, d: string): number | null;
  lastTemplate(pubkey: string, kind: number, d: string): unknown;
  // The calendar keys the index once held, as their retirement recorded them
  // (spec/indexer-rules.md § 8); none on an index that never had any.
  retiredCalendarKeys(): string[];
  loadPresence(calendarD: string): PresenceState;
  savePresence(calendarD: string, state: PresenceState): void;
  pollState(calendarD: string): PollState;
  savePollState(calendarD: string, state: PollState): void;
  localNameFor(calendarD: string): string;
  calendarForLocalName(name: string): string | null;
  // Stores a record's text and returns when it last changed.
  putRecord(r: { calendarD: string; uid: string; id: string; ics: string; now: number }): number;
  record(id: string): { calendarD: string; uid: string; ics: string; changedAt: number } | null;
  recordsOf(calendarD: string): Array<{ id: string; uid: string; ics: string; changedAt: number }>;
  close(): void;
}

export function openIndexDb(path: string): IndexDb {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The poll service and the API share the file.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const getProjection = db.prepare<[string, number, string], { hash: string; created_at: number; start: number; status: ProjectionRow['status'] }>(
    'SELECT hash, created_at, start, status FROM projections WHERE pubkey = ? AND kind = ? AND d = ?',
  );
  const upsertProjection = db.prepare(
    `INSERT INTO projections (pubkey, kind, d, hash, created_at, start, status, template) VALUES (@pubkey, @kind, @d, @hash, @createdAt, @start, 'live', @template)
     ON CONFLICT (pubkey, kind, d) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at, start = excluded.start, status = 'live', template = excluded.template`,
  );
  const insertVersion = db.prepare('INSERT OR IGNORE INTO versions (pubkey, kind, d, event_id, created_at) VALUES (@pubkey, @kind, @d, @eventId, @createdAt)');
  const listVersions = db.prepare<[string, number, string], { event_id: string }>(
    'SELECT event_id FROM versions WHERE pubkey = ? AND kind = ? AND d = ? ORDER BY created_at, event_id',
  );
  const getTemplate = db.prepare<[string, number, string], { template: string | null }>('SELECT template FROM projections WHERE pubkey = ? AND kind = ? AND d = ?');
  const setStatus = db.prepare('UPDATE projections SET status = ? WHERE pubkey = ? AND kind = ? AND d = ?');
  const getPresence = db.prepare<[string], { state: string }>('SELECT state FROM presence WHERE calendar_d = ?');
  const putPresence = db.prepare('INSERT INTO presence (calendar_d, state) VALUES (?, ?) ON CONFLICT (calendar_d) DO UPDATE SET state = excluded.state');
  const getPoll = db.prepare<[string], { state: string }>('SELECT state FROM poll_state WHERE calendar_d = ?');
  const putPoll = db.prepare('INSERT INTO poll_state (calendar_d, state) VALUES (?, ?) ON CONFLICT (calendar_d) DO UPDATE SET state = excluded.state');
  const nameOf = db.prepare<[string], { name: string }>('SELECT name FROM local_names WHERE calendar_d = ?');
  const calendarOf = db.prepare<[string], { calendar_d: string }>('SELECT calendar_d FROM local_names WHERE name = ?');
  const insertName = db.prepare('INSERT INTO local_names (name, calendar_d) VALUES (?, ?)');
  const getRecord = db.prepare<[string, string], { ics: string; changed_at: number }>('SELECT ics, changed_at FROM records WHERE calendar_d = ? AND uid = ?');
  const getRecordById = db.prepare<[string], { calendar_d: string; uid: string; ics: string; changed_at: number }>(
    'SELECT calendar_d, uid, ics, changed_at FROM records WHERE id = ?',
  );
  const upsertRecord = db.prepare(
    `INSERT INTO records (id, calendar_d, uid, ics, changed_at) VALUES (@id, @calendarD, @uid, @ics, @changedAt)
     ON CONFLICT (calendar_d, uid) DO UPDATE SET id = excluded.id, ics = excluded.ics, changed_at = excluded.changed_at`,
  );

  const projection = (pubkey: string, kind: number, d: string): ProjectionRow | null => {
    const row = getProjection.get(pubkey, kind, d);
    return row ? { hash: row.hash, createdAt: row.created_at, start: row.start, status: row.status } : null;
  };

  const assignName = db.transaction((calendarD: string): string => {
    const existing = nameOf.get(calendarD);
    if (existing) return existing.name;
    const base = localName(calendarD);
    let name = base;
    for (let n = 2; calendarOf.get(name); n += 1) name = `${base}-${n}`;
    insertName.run(name, calendarD);
    return name;
  });

  const publish = db.transaction((p: Published) => {
    upsertProjection.run({ ...p, template: p.template === undefined ? null : JSON.stringify(p.template) });
    insertVersion.run(p);
  });

  return {
    raw: db,
    shouldPublish: (pubkey, kind, d, hash) => {
      const row = projection(pubkey, kind, d);
      return !row || row.status !== 'live' || row.hash !== hash;
    },
    markPublished: (p) => publish(p),
    markWithdrawn: (pubkey, kind, d, status) => void setStatus.run(status, pubkey, kind, d),
    projection,
    versions: (pubkey, kind, d) => listVersions.all(pubkey, kind, d).map((r) => r.event_id),
    lastCreatedAt: (pubkey, kind, d) => projection(pubkey, kind, d)?.createdAt ?? null,
    retiredCalendarKeys: () => (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retirement'").get()
      ? db.prepare<[], { pubkey: string }>('SELECT DISTINCT pubkey FROM retirement ORDER BY pubkey').all().map((r) => r.pubkey)
      : []),
    recordsOf: (calendarD) => db.prepare<[string], { id: string; uid: string; ics: string; changed_at: number }>(
      'SELECT id, uid, ics, changed_at FROM records WHERE calendar_d = ? ORDER BY uid',
    ).all(calendarD).map((r) => ({ id: r.id, uid: r.uid, ics: r.ics, changedAt: r.changed_at })),
    lastTemplate: (pubkey, kind, d) => {
      const row = getTemplate.get(pubkey, kind, d);
      return row?.template ? JSON.parse(row.template) : null;
    },
    loadPresence: (calendarD) => {
      const row = getPresence.get(calendarD);
      return row ? (JSON.parse(row.state) as PresenceState) : emptyPresence();
    },
    savePresence: (calendarD, state) => void putPresence.run(calendarD, JSON.stringify(state)),
    pollState: (calendarD) => {
      const row = getPoll.get(calendarD);
      return row ? { ...NEW_POLL_STATE, ...(JSON.parse(row.state) as Partial<PollState>) } : { ...NEW_POLL_STATE };
    },
    savePollState: (calendarD, state) => void putPoll.run(calendarD, JSON.stringify(state)),
    // Reads, then writes: the write lock is taken first (see nostr-events.ts).
    localNameFor: (calendarD) => assignName.immediate(calendarD),
    calendarForLocalName: (name) => calendarOf.get(name)?.calendar_d ?? null,
    putRecord: ({ calendarD, uid, id, ics, now }) => {
      const existing = getRecord.get(calendarD, uid);
      if (existing && existing.ics === ics) return existing.changed_at;
      upsertRecord.run({ id, calendarD, uid, ics, changedAt: now });
      return now;
    },
    record: (id) => {
      const row = getRecordById.get(id);
      return row ? { calendarD: row.calendar_d, uid: row.uid, ics: row.ics, changedAt: row.changed_at } : null;
    },
    close: () => db.close(),
  };
}
