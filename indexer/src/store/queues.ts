// What waits for a maintainer's review: feeds people submit, and requests to
// remove a calendar. Nothing here holds an address or a network identifier.

import { randomBytes } from 'node:crypto';
import type { IndexDb } from './index-db.ts';
import type { Role, Source } from '../types.ts';
import { base32 } from '../project/ids.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  d TEXT NOT NULL UNIQUE,
  feed_url TEXT NOT NULL,
  source TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT,
  platform_default INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS remove_requests (
  id INTEGER PRIMARY KEY,
  d TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  message TEXT,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verified_at INTEGER,
  resolved_at INTEGER
);
`;

export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'undone';
export type RemovalStatus = 'pending' | 'approved' | 'rejected' | 'done';

export interface Submission {
  id: number;
  d: string;
  feedUrl: string;
  source: Source;
  role: Role;
  name: string | null;
  // A platform account's default calendar (Luma's Personal), which only its
  // owner should submit.
  platformDefault: boolean;
  submittedAt: number;
  status: SubmissionStatus;
  // Who approved it: the index itself (`auto`) or a maintainer.
  approvedBy: 'auto' | 'maintainer' | null;
  resolvedAt: number | null;
}

export interface RemoveRequest {
  id: number;
  d: string;
  token: string;
  message: string | null;
  requestedAt: number;
  status: RemovalStatus;
  verifiedAt: number | null;
  resolvedAt: number | null;
}

export const TOKEN_PREFIX = 'eventindex-remove-';

export function queueStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const columns = db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('submissions')").all().map((c) => c.name);
  if (!columns.includes('approved_by')) db.exec('ALTER TABLE submissions ADD COLUMN approved_by TEXT');
  const subOf = (r: Record<string, unknown>): Submission => ({
    id: r['id'] as number, d: r['d'] as string, feedUrl: r['feed_url'] as string, source: r['source'] as Source, role: r['role'] as Role,
    name: r['name'] as string | null, platformDefault: r['platform_default'] === 1, submittedAt: r['submitted_at'] as number, status: r['status'] as SubmissionStatus,
    approvedBy: r['approved_by'] as Submission['approvedBy'], resolvedAt: r['resolved_at'] as number | null,
  });
  const remOf = (r: Record<string, unknown>): RemoveRequest => ({
    id: r['id'] as number, d: r['d'] as string, token: r['token'] as string, message: r['message'] as string | null,
    requestedAt: r['requested_at'] as number, status: r['status'] as RemovalStatus, verifiedAt: r['verified_at'] as number | null,
    resolvedAt: r['resolved_at'] as number | null,
  });

  return {
    submit(s: { d: string; feedUrl: string; source: Source; role: Role; name: string | null; platformDefault?: boolean; at: number }, cap: number):
      { status: 'queued' | 'already-queued'; id: number } | { status: 'queue-full' } {
      const existing = db.prepare<[string], { id: number }>('SELECT id FROM submissions WHERE d = ?').get(s.d);
      if (existing) return { status: 'already-queued', id: existing.id };
      const pending = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM submissions WHERE status = 'pending'").get()!.n;
      if (pending >= cap) return { status: 'queue-full' };
      const result = db.prepare('INSERT INTO submissions (d, feed_url, source, role, name, platform_default, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(s.d, s.feedUrl, s.source, s.role, s.name, s.platformDefault ? 1 : 0, s.at);
      return { status: 'queued', id: Number(result.lastInsertRowid) };
    },
    submissions: (status: SubmissionStatus) =>
      db.prepare<[string], Record<string, unknown>>('SELECT * FROM submissions WHERE status = ? ORDER BY id').all(status).map(subOf),
    submission(id: number): Submission | null {
      const r = db.prepare<[number], Record<string, unknown>>('SELECT * FROM submissions WHERE id = ?').get(id);
      return r ? subOf(r) : null;
    },
    resolveSubmission: (id: number, status: Exclude<SubmissionStatus, 'pending'>, at: number, by: 'auto' | 'maintainer' | null = null) =>
      void db.prepare('UPDATE submissions SET status = ?, resolved_at = ?, approved_by = coalesce(?, approved_by) WHERE id = ?').run(status, at, by, id),
    // Submissions the index approved itself, newest first.
    autoApproved: (since = 0) =>
      db.prepare<[number], Record<string, unknown>>("SELECT * FROM submissions WHERE approved_by = 'auto' AND resolved_at >= ? ORDER BY resolved_at DESC, id DESC").all(since).map(subOf),

    requestRemoval(r: { d: string; message: string | null; at: number }): { id: number; token: string } {
      const token = `${TOKEN_PREFIX}${base32(randomBytes(7)).slice(0, 10)}`;
      const result = db.prepare('INSERT INTO remove_requests (d, token, message, requested_at) VALUES (?, ?, ?, ?)').run(r.d, token, r.message, r.at);
      return { id: Number(result.lastInsertRowid), token };
    },
    removals: (status: RemovalStatus) =>
      db.prepare<[string], Record<string, unknown>>('SELECT * FROM remove_requests WHERE status = ? ORDER BY id').all(status).map(remOf),
    removal(id: number): RemoveRequest | null {
      const r = db.prepare<[number], Record<string, unknown>>('SELECT * FROM remove_requests WHERE id = ?').get(id);
      return r ? remOf(r) : null;
    },
    openRemovalsFor: (d: string) =>
      db.prepare<[string], Record<string, unknown>>("SELECT * FROM remove_requests WHERE d = ? AND status = 'pending' ORDER BY id").all(d).map(remOf),
    markVerified: (id: number, at: number) => void db.prepare('UPDATE remove_requests SET verified_at = coalesce(verified_at, ?) WHERE id = ?').run(at, id),
    resolveRemoval: (id: number, status: Exclude<RemovalStatus, 'pending'>, at: number) =>
      void db.prepare('UPDATE remove_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, at, id),
  };
}

export type QueueStore = ReturnType<typeof queueStore>;
