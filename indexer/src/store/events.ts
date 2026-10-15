// The projected occurrences of every calendar, rewritten after each poll, so
// the API answers listings and searches without reading feeds.

import type { IndexDb } from './index-db.ts';
import { directoryStore } from './directory.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  calendar_d TEXT NOT NULL,
  record_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  d TEXT NOT NULL,
  kind INTEGER NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER,
  tzid TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  location TEXT,
  g TEXT,
  tags TEXT NOT NULL,
  url TEXT,
  cancelled INTEGER NOT NULL,
  canonical TEXT,
  cohosts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_d, start);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
`;

export interface EventRow {
  id: string;
  calendarD: string;
  recordId: string;
  uid: string;
  d: string;
  kind: number;
  start: number;
  end: number | null;
  // The IANA zone of the start, when it has one.
  tzid: string | null;
  title: string;
  summary: string | null;
  location: string | null;
  g: string | null;
  tags: string[];
  url: string | null;
  cancelled: boolean;
  // The public id of the record this one yields to, for a co-host's copy.
  canonical: string | null;
  cohosts: string[];
}

export interface EventQuery {
  q?: string;
  from: number;
  to: number;
  near?: string;
  tag?: string;
  calendars?: string[];
  limit?: number;
}

const escape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function eventStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  // An event's area falls back to its calendar's directory entry.
  directoryStore(index);
  const of = (r: Record<string, unknown>): EventRow => ({
    id: r['id'] as string, calendarD: r['calendar_d'] as string, recordId: r['record_id'] as string, uid: r['uid'] as string,
    d: r['d'] as string, kind: r['kind'] as number, start: r['start'] as number, end: r['end'] as number | null, tzid: r['tzid'] as string | null, title: r['title'] as string,
    summary: r['summary'] as string | null, location: r['location'] as string | null, g: r['g'] as string | null,
    tags: JSON.parse(r['tags'] as string) as string[], url: r['url'] as string | null, cancelled: r['cancelled'] === 1,
    canonical: r['canonical'] as string | null, cohosts: JSON.parse(r['cohosts'] as string) as string[],
  });
  const insert = db.prepare(`INSERT OR REPLACE INTO events (id, calendar_d, record_id, uid, d, kind, start, "end", tzid, title, summary, location, g, tags, url, cancelled, canonical, cohosts)
    VALUES (@id, @calendarD, @recordId, @uid, @d, @kind, @start, @end, @tzid, @title, @summary, @location, @g, @tags, @url, @cancelled, @canonical, @cohosts)`);
  const replace = db.transaction((calendarD: string, rows: EventRow[]) => {
    db.prepare('DELETE FROM events WHERE calendar_d = ?').run(calendarD);
    for (const r of rows) insert.run({ ...r, tags: JSON.stringify(r.tags), cohosts: JSON.stringify(r.cohosts), cancelled: r.cancelled ? 1 : 0 });
  });

  const search = (query: EventQuery): EventRow[] => {
    const where = ['start <= ?', 'coalesce("end", start) >= ?'];
    const params: Array<string | number> = [query.to, query.from];
    if (query.q) {
      where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')");
      const term = `%${escape(query.q)}%`;
      params.push(term, term, term);
    }
    // An event with no coordinates (a hidden venue, a feed without GEO) is
    // near where its calendar's area is.
    if (query.near) {
      where.push(`(g LIKE ? ESCAPE '\\' OR (g IS NULL AND calendar_d IN (SELECT d FROM directory WHERE removed IS NULL AND g IS NOT NULL
        AND (g LIKE ? ESCAPE '\\' OR ? LIKE g || '%'))))`);
      params.push(`${escape(query.near)}%`, `${escape(query.near)}%`, query.near);
    }
    if (query.tag) {
      where.push("tags LIKE ? ESCAPE '\\'");
      params.push(`%${escape(JSON.stringify(query.tag.toLowerCase()))}%`);
    }
    if (query.calendars) {
      where.push(`calendar_d IN (${query.calendars.map(() => '?').join(', ') || "''"})`);
      params.push(...query.calendars);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    return db.prepare<Array<string | number>, Record<string, unknown>>(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY start, id LIMIT ${limit}`)
      .all(...params).map(of);
  };

  return {
    replaceCalendar: (calendarD: string, rows: EventRow[]) => replace(calendarD, rows),
    removeCalendar: (calendarD: string) => void db.prepare('DELETE FROM events WHERE calendar_d = ?').run(calendarD),
    byId(id: string): EventRow | null {
      const r = db.prepare<[string], Record<string, unknown>>('SELECT * FROM events WHERE id = ?').get(id);
      return r ? of(r) : null;
    },
    byCalendar: (calendarD: string, from: number, to: number, limit = 500) => search({ from, to, calendars: [calendarD], limit }),
    search,
    countUpcoming: (now: number) => db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM events WHERE start >= ?').get(now)!.n,
    countByCalendar: (calendarD: string) => db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM events WHERE calendar_d = ?').get(calendarD)!.n,
    // The calendars with an event carrying the topic.
    calendarsWithTag: (tag: string) => db.prepare<[string], { d: string }>("SELECT DISTINCT calendar_d AS d FROM events WHERE tags LIKE ? ESCAPE '\\'")
      .all(`%${escape(JSON.stringify(tag.toLowerCase()))}%`).map((r) => r.d),
    count: () => db.prepare<[], { n: number }>('SELECT count(*) AS n FROM events').get()!.n,
  };
}

export type EventStore = ReturnType<typeof eventStore>;
