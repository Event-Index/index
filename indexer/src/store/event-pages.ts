// Event pages read for what a feed leaves out (enrich/meetup-pages.ts): for
// each event, its page, what its feed said (so a page's values can be
// applied again or undone), and what the page said at its last read, with
// the validators for the next. Also the reader's state: the site's
// robots.txt, refusals in a row, and a pause or a stop.

import type { IndexDb } from './index-db.ts';
import type { FeedSays } from '../enrich/apply.ts';
import type { PageFacts } from '../enrich/event-page.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_pages (
  calendar_d TEXT NOT NULL,
  uid TEXT NOT NULL,
  url TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  feed TEXT NOT NULL,
  feed_stamp TEXT NOT NULL,
  read_stamp TEXT,
  read_at INTEGER,
  outcome TEXT,
  facts TEXT,
  etag TEXT,
  last_modified TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  PRIMARY KEY (calendar_d, uid)
);
CREATE INDEX IF NOT EXISTS event_pages_due ON event_pages(end, start);
CREATE TABLE IF NOT EXISTS event_pages_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// How a page's last read ended: read (facts, or null when its JSON-LD names
// no event), disallowed by robots.txt, gone (404, 410), or failed too often.
export type Outcome = 'read' | 'disallowed' | 'gone' | 'failed';

export interface PageRow {
  calendarD: string;
  uid: string;
  url: string;
  start: number;
  end: number;
  feed: FeedSays;
  readStamp: string | null;
  readAt: number | null;
  outcome: Outcome | null;
  facts: PageFacts | null;
  etag: string | null;
  lastModified: string | null;
  attempts: number;
}

export interface ReaderState {
  robots: string | null;
  robotsAt: number | null;
  // When robots.txt could not be read: until then, no page is.
  robotsRetryAt: number | null;
  strikes: number;
  pausedUntil: number | null;
  stoppedAt: number | null;
}

interface Row {
  calendar_d: string; uid: string; url: string; start: number; end: number; feed: string; feed_stamp: string;
  read_stamp: string | null; read_at: number | null; outcome: Outcome | null; facts: string | null;
  etag: string | null; last_modified: string | null; attempts: number; retry_at: number | null;
}

const of = (r: Row): PageRow => ({
  calendarD: r.calendar_d, uid: r.uid, url: r.url, start: r.start, end: r.end, feed: JSON.parse(r.feed) as FeedSays,
  readStamp: r.read_stamp, readAt: r.read_at, outcome: r.outcome, facts: r.facts ? (JSON.parse(r.facts) as PageFacts) : null,
  etag: r.etag, lastModified: r.last_modified, attempts: r.attempts,
});

export function eventPagesStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const getRow = db.prepare<[string, string], Row>('SELECT * FROM event_pages WHERE calendar_d = ? AND uid = ?');
  const getState = db.prepare<[string], { value: string }>('SELECT value FROM event_pages_state WHERE key = ?');
  const putState = db.prepare('INSERT INTO event_pages_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const number = (key: string) => {
    const v = getState.get(key)?.value;
    return v === undefined ? null : Number(v);
  };
  const set = (key: string, value: string | number | null) => {
    if (value === null) db.prepare('DELETE FROM event_pages_state WHERE key = ?').run(key);
    else putState.run(key, String(value));
  };

  return {
    // What a poll read of an event. A new page forgets what the old one said.
    observe(p: { calendarD: string; uid: string; url: string; start: number; end: number; feed: FeedSays }): void {
      const existing = getRow.get(p.calendarD, p.uid);
      if (existing && existing.url !== p.url) db.prepare('DELETE FROM event_pages WHERE calendar_d = ? AND uid = ?').run(p.calendarD, p.uid);
      db.prepare(`INSERT INTO event_pages (calendar_d, uid, url, start, end, feed, feed_stamp) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (calendar_d, uid) DO UPDATE SET start = excluded.start, end = excluded.end, feed = excluded.feed, feed_stamp = excluded.feed_stamp,
          attempts = CASE WHEN feed_stamp = excluded.feed_stamp THEN attempts ELSE 0 END,
          retry_at = CASE WHEN feed_stamp = excluded.feed_stamp THEN retry_at ELSE NULL END`)
        .run(p.calendarD, p.uid, p.url, p.start, p.end, JSON.stringify(p.feed), p.feed.stamp);
    },
    get: (calendarD: string, uid: string): PageRow | null => {
      const row = getRow.get(calendarD, uid);
      return row ? of(row) : null;
    },
    // Upcoming events whose page was not read for what their feed says now,
    // soonest first.
    due: (now: number, limit: number): PageRow[] => db.prepare<[number, number, number], Row>(
      `SELECT * FROM event_pages WHERE end >= ? AND (read_stamp IS NULL OR read_stamp != feed_stamp) AND (retry_at IS NULL OR retry_at <= ?)
       ORDER BY start, calendar_d, uid LIMIT ?`,
    ).all(now, now, limit).map(of),
    read(calendarD: string, uid: string, r: { stamp: string; at: number; outcome: Outcome; facts: PageFacts | null; etag?: string | null; lastModified?: string | null }): void {
      db.prepare(`UPDATE event_pages SET read_stamp = ?, read_at = ?, outcome = ?, facts = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
        attempts = 0, retry_at = NULL WHERE calendar_d = ? AND uid = ?`)
        .run(r.stamp, r.at, r.outcome, r.facts ? JSON.stringify(r.facts) : null, r.etag ?? null, r.lastModified ?? null, calendarD, uid);
    },
    // A failed read: tried again at `retryAt`, or, after `maxAttempts`, left
    // until the feed says something new.
    failed(calendarD: string, uid: string, retryAt: number, maxAttempts: number): void {
      db.prepare(`UPDATE event_pages SET attempts = attempts + 1, retry_at = ?,
        read_stamp = CASE WHEN attempts + 1 >= ? THEN feed_stamp ELSE read_stamp END,
        outcome = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE outcome END WHERE calendar_d = ? AND uid = ?`)
        .run(retryAt, maxAttempts, maxAttempts, calendarD, uid);
    },
    // Events over for a month are forgotten.
    forgetBefore: (at: number) => db.prepare('DELETE FROM event_pages WHERE end < ?').run(at).changes,
    counts: () => db.prepare<[], { outcome: string | null; n: number }>('SELECT outcome, count(*) AS n FROM event_pages GROUP BY outcome').all(),
    state: (): ReaderState => ({
      robots: getState.get('robots')?.value ?? null,
      robotsAt: number('robots_at'),
      robotsRetryAt: number('robots_retry_at'),
      strikes: number('strikes') ?? 0,
      pausedUntil: number('paused_until'),
      stoppedAt: number('stopped_at'),
    }),
    setRobots(text: string | null, at: number, retryAt: number | null): void {
      if (text !== null) {
        set('robots', text);
        set('robots_at', at);
      }
      set('robots_retry_at', retryAt);
    },
    refused(strikes: number, pausedUntil: number | null, stoppedAt: number | null): void {
      set('strikes', strikes);
      set('paused_until', pausedUntil);
      set('stopped_at', stoppedAt);
    },
    answered: () => set('strikes', 0),
    // The operator's word after a stop (eventindex-admin meetup-pages resume).
    resume(): void {
      set('strikes', 0);
      set('paused_until', null);
      set('stopped_at', null);
    },
  };
}

export type EventPagesStore = ReturnType<typeof eventPagesStore>;
