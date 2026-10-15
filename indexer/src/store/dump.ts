// The nightly public dump: the directory, calendar metadata and poll
// statistics, dedicated to the public domain. No event content, no queue,
// no validator or key material.

import { existsSync, renameSync, rmSync } from 'node:fs';
import type { IndexDb } from './index-db.ts';
import { directoryStore } from './directory.ts';

export function makeDump(index: IndexDb, out: string, now: number): void {
  directoryStore(index);
  const tmp = `${out}.tmp`;
  if (existsSync(tmp)) rmSync(tmp);
  const db = index.raw;
  db.prepare('ATTACH DATABASE ? AS dump').run(tmp);
  try {
    db.exec(`
      CREATE TABLE dump.calendars AS
        SELECT directory.d, role, source, feed_url, page_url, directory.name AS name, description, image, location, g, found_via,
               pubkey, local_names.name AS local_name, added_at, removed, removed_at
        FROM directory LEFT JOIN local_names ON local_names.calendar_d = directory.d
        ORDER BY directory.d;
      CREATE TABLE dump.poll_stats AS
        SELECT calendar_d AS d,
               json_extract(state, '$.lastSuccessAt') AS last_success_at,
               json_extract(state, '$.failures') AS failures,
               json_extract(state, '$.stale') AS stale
        FROM poll_state ORDER BY calendar_d;
      CREATE TABLE dump.about (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const about = db.prepare('INSERT INTO dump.about (key, value) VALUES (?, ?)');
    about.run('generated_at', String(now));
    about.run('license', 'CC0-1.0');
    about.run('contents', 'Event Index directory entries, calendar metadata and poll statistics. Event content is not included.');
  } finally {
    db.exec('DETACH DATABASE dump');
  }
  renameSync(tmp, out);
}
