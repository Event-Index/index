// What waits for a maintainer's review: feeds people submit, requests to
// remove a calendar, and organizers' claims of their calendars. Nothing here
// holds an address or a network identifier; a signer's connection is held
// only sealed for the poll service, and only until it is used.

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
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  d TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT,
  token TEXT UNIQUE,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verified_by TEXT,
  verified_at INTEGER,
  nip05 TEXT,
  signer TEXT,
  note TEXT,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_seen (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
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
export type ClaimStatus = 'pending' | 'approved' | 'rejected' | 'done' | 'failed';
// A claim of a mirrored calendar, or what its owner asks once it is theirs:
// connect a signer, or disconnect it.
export type ClaimKind = 'claim' | 'connect' | 'disconnect';
// `own`: the organizer publishes from their own key; `delegated`: the index
// publishes as them, through their signer.
// own: the organizer publishes it; delegated: the index publishes as them;
// link: the index keeps mirroring it and names their key as its organizer's.
export type ClaimMode = 'own' | 'delegated' | 'link';

export interface Claim {
  id: number;
  d: string;
  // The organizer's key, proven when the claim was made.
  pubkey: string;
  kind: ClaimKind;
  mode: ClaimMode | null;
  token: string | null;
  requestedAt: number;
  status: ClaimStatus;
  // How control of the calendar was shown.
  verifiedBy: 'token' | 'nip05' | null;
  verifiedAt: number | null;
  nip05: string | null;
  // The signer's connection, sealed for the poll service.
  signer: string | null;
  // Why it failed.
  note: string | null;
  resolvedAt: number | null;
}
// A request whose token was never seen expires (spec/indexer-rules.md § 10).
export type RemovalStatus = 'pending' | 'approved' | 'rejected' | 'done' | 'expired';

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
  // The city the submitter names, a slug of seeds/cities.json.
  city: string | null;
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
export const CLAIM_TOKEN_PREFIX = 'eventindex-claim-';
// How long a used proof of a key is remembered: longer than it is valid.
const AUTH_MEMORY = 300;

const token = (prefix: string) => `${prefix}${base32(randomBytes(7)).slice(0, 10)}`;

export function queueStore(index: IndexDb) {
  const db = index.raw;
  db.exec(SCHEMA);
  const columns = new Set(db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('submissions')").all().map((c) => c.name));
  if (!columns.has('approved_by')) db.exec('ALTER TABLE submissions ADD COLUMN approved_by TEXT');
  if (!columns.has('city')) db.exec('ALTER TABLE submissions ADD COLUMN city TEXT');
  const subOf = (r: Record<string, unknown>): Submission => ({
    id: r['id'] as number, d: r['d'] as string, feedUrl: r['feed_url'] as string, source: r['source'] as Source, role: r['role'] as Role,
    name: r['name'] as string | null, platformDefault: r['platform_default'] === 1, submittedAt: r['submitted_at'] as number, status: r['status'] as SubmissionStatus,
    city: (r['city'] as string | null) ?? null,
    approvedBy: r['approved_by'] as Submission['approvedBy'], resolvedAt: r['resolved_at'] as number | null,
  });
  const claimOf = (r: Record<string, unknown>): Claim => ({
    id: r['id'] as number, d: r['d'] as string, pubkey: r['pubkey'] as string, kind: r['kind'] as ClaimKind, mode: r['mode'] as ClaimMode | null,
    token: r['token'] as string | null, requestedAt: r['requested_at'] as number, status: r['status'] as ClaimStatus,
    verifiedBy: r['verified_by'] as Claim['verifiedBy'], verifiedAt: r['verified_at'] as number | null, nip05: r['nip05'] as string | null,
    signer: r['signer'] as string | null, note: r['note'] as string | null, resolvedAt: r['resolved_at'] as number | null,
  });
  const remOf = (r: Record<string, unknown>): RemoveRequest => ({
    id: r['id'] as number, d: r['d'] as string, token: r['token'] as string, message: r['message'] as string | null,
    requestedAt: r['requested_at'] as number, status: r['status'] as RemovalStatus, verifiedAt: r['verified_at'] as number | null,
    resolvedAt: r['resolved_at'] as number | null,
  });

  return {
    submit(s: { d: string; feedUrl: string; source: Source; role: Role; name: string | null; platformDefault?: boolean; city?: string | null; at: number }, cap: number):
      { status: 'queued' | 'already-queued'; id: number } | { status: 'queue-full' } {
      const existing = db.prepare<[string], { id: number }>('SELECT id FROM submissions WHERE d = ?').get(s.d);
      if (existing) return { status: 'already-queued', id: existing.id };
      const pending = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM submissions WHERE status = 'pending'").get()!.n;
      if (pending >= cap) return { status: 'queue-full' };
      const result = db.prepare('INSERT INTO submissions (d, feed_url, source, role, name, platform_default, city, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.d, s.feedUrl, s.source, s.role, s.name, s.platformDefault ? 1 : 0, s.city ?? null, s.at);
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
      const issued = token(TOKEN_PREFIX);
      const result = db.prepare('INSERT INTO remove_requests (d, token, message, requested_at) VALUES (?, ?, ?, ?)').run(r.d, issued, r.message, r.at);
      return { id: Number(result.lastInsertRowid), token: issued };
    },
    removals: (status: RemovalStatus) =>
      db.prepare<[string], Record<string, unknown>>('SELECT * FROM remove_requests WHERE status = ? ORDER BY id').all(status).map(remOf),
    // Pending requests whose token was seen (the review list), or not yet.
    waitingRemovals: (proven: boolean) =>
      db.prepare<[], Record<string, unknown>>(`SELECT * FROM remove_requests WHERE status = 'pending' AND verified_at IS ${proven ? 'NOT ' : ''}NULL ORDER BY id`).all().map(remOf),
    // Requests made since a time, whatever became of them.
    removalsSince: (since: number) =>
      db.prepare<[number], Record<string, unknown>>('SELECT * FROM remove_requests WHERE requested_at >= ? ORDER BY id').all(since).map(remOf),
    // Pending requests made before a time whose token was never seen.
    expireRemovals: (before: number, at: number): number =>
      db.prepare("UPDATE remove_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND verified_at IS NULL AND requested_at < ?").run(at, before).changes,
    removal(id: number): RemoveRequest | null {
      const r = db.prepare<[number], Record<string, unknown>>('SELECT * FROM remove_requests WHERE id = ?').get(id);
      return r ? remOf(r) : null;
    },
    openRemovalsFor: (d: string) =>
      db.prepare<[string], Record<string, unknown>>("SELECT * FROM remove_requests WHERE d = ? AND status = 'pending' ORDER BY id").all(d).map(remOf),
    markVerified: (id: number, at: number) => void db.prepare('UPDATE remove_requests SET verified_at = coalesce(verified_at, ?) WHERE id = ?').run(at, id),
    resolveRemoval: (id: number, status: Exclude<RemovalStatus, 'pending'>, at: number) =>
      void db.prepare('UPDATE remove_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, at, id),

    // Records a proof of a key as used; false when it was used before.
    useAuth(id: string, at: number): boolean {
      db.prepare('DELETE FROM auth_seen WHERE at < ?').run(at - AUTH_MEMORY);
      return db.prepare('INSERT OR IGNORE INTO auth_seen (id, at) VALUES (?, ?)').run(id, at).changes === 1;
    },

    requestClaim(c: { d: string; pubkey: string; mode: ClaimMode; signer: string | null; at: number }): { id: number; token: string } {
      const issued = token(CLAIM_TOKEN_PREFIX);
      const result = db.prepare("INSERT INTO claims (d, pubkey, kind, mode, token, signer, requested_at) VALUES (?, ?, 'claim', ?, ?, ?, ?)")
        .run(c.d, c.pubkey, c.mode, issued, c.signer, c.at);
      return { id: Number(result.lastInsertRowid), token: issued };
    },
    // What a calendar's owner asks: carried out without review.
    ownerRequest(c: { d: string; pubkey: string; kind: Exclude<ClaimKind, 'claim'>; signer: string | null; at: number }): number {
      const mode = c.kind === 'connect' ? 'delegated' : 'own';
      const result = db.prepare("INSERT INTO claims (d, pubkey, kind, mode, signer, requested_at, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')")
        .run(c.d, c.pubkey, c.kind, mode, c.signer, c.at);
      return Number(result.lastInsertRowid);
    },
    claims: (status: ClaimStatus) =>
      db.prepare<[string], Record<string, unknown>>('SELECT * FROM claims WHERE status = ? ORDER BY id').all(status).map(claimOf),
    claim(id: number): Claim | null {
      const r = db.prepare<[number], Record<string, unknown>>('SELECT * FROM claims WHERE id = ?').get(id);
      return r ? claimOf(r) : null;
    },
    openClaimsFor: (d: string) =>
      db.prepare<[string], Record<string, unknown>>("SELECT * FROM claims WHERE d = ? AND kind = 'claim' AND status = 'pending' ORDER BY id").all(d).map(claimOf),
    markClaimVerified: (id: number, by: 'token' | 'nip05', nip05: string | null, at: number) =>
      void db.prepare('UPDATE claims SET verified_by = coalesce(verified_by, ?), nip05 = coalesce(nip05, ?), verified_at = coalesce(verified_at, ?) WHERE id = ?')
        .run(by, nip05, at, id),
    // A claim that is over no longer keeps its signer.
    resolveClaim(id: number, status: Exclude<ClaimStatus, 'pending'>, at: number, note: string | null = null): void {
      const over = status !== 'approved';
      db.prepare(`UPDATE claims SET status = ?, resolved_at = ?, note = coalesce(?, note)${over ? ', signer = NULL' : ''} WHERE id = ?`).run(status, at, note, id);
    },
  };
}

export type QueueStore = ReturnType<typeof queueStore>;
