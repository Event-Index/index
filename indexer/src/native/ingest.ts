// Every public NIP-52 calendar event (kinds 31922 and 31923), read by kind
// from the relays that carry them: each relay's history page by page (`until`),
// then what is new every few minutes (`since`), and its history again each
// week for what a sync missed (events published late, or back-dated). Each
// event's signature is checked and the basic hygiene of a commons applied;
// trust is a reader's concern, so everything else is kept, as signed. The
// publishers' deletions of their events (kind 5 naming 31922 or 31923 in `k`)
// are read the same way and applied.

import { verifyEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { RelayReader } from './read.ts';
import type { Found, NostrEvent } from './record.ts';
import type { Cursor, NostrStore } from '../store/nostr-events.ts';

export interface IngestSource {
  url: string;
  // A search relay: plain reads are asked with its `include:spam` extension.
  search: boolean;
}

export const PAGE = 500;
// At most this many pages per relay and stream in one step.
export const PAGES_PER_STEP = 8;
// How often a relay is asked for what is new, and how far back each time.
export const SYNC_EVERY = 300;
export const SYNC_OVERLAP = 3600;
// How often a relay's history is read again.
export const RESCAN_EVERY = 7 * 86400;
// Starts outside these are absurd: before 1990, or more than ten years ahead.
const EARLIEST = 631152000;
const AHEAD = 10 * 365 * 86400;

const STREAMS: Record<'events' | 'deletions', Filter> = {
  events: { kinds: [31922, 31923] },
  deletions: { kinds: [5], '#k': ['31922', '31923'] },
};

export interface IngestDeps {
  reader: RelayReader;
  store: NostrStore;
  now: number;
  // Events never kept: what the index signs itself, removed publishers, keys
  // whose secret is public.
  skip: (event: NostrEvent) => boolean;
  log: (line: string) => void;
  // A pause between pages, to be polite to relays.
  pause?: () => Promise<void>;
}

export interface IngestReport {
  read: number;
  kept: number;
  deletions: number;
  dropped: Record<string, number>;
}

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];

function signed(event: NostrEvent): boolean {
  const { id, pubkey, kind, created_at, tags, content, sig } = event;
  try {
    return verifyEvent({ id, pubkey, kind, created_at, tags, content, sig } as Parameters<typeof verifyEvent>[0]);
  } catch {
    return false;
  }
}

// Why an event is left out, or null when it is kept.
export function acceptable(event: NostrEvent, now: number): string | null {
  if (event.kind !== 31922 && event.kind !== 31923) return 'kind';
  if (!signed(event)) return 'signature';
  if (tag(event, 'd') === undefined) return 'no-d';
  if (!(tag(event, 'title') ?? '').trim() && !(tag(event, 'name') ?? '').trim()) return 'no-title';
  const start = tag(event, 'start');
  if (start === undefined) return 'no-start';
  let at: number;
  if (event.kind === 31923) {
    if (!/^\d{1,12}$/.test(start)) return 'bad-start';
    at = Number(start);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
    if (!match) return 'bad-start';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return 'bad-start';
    at = date.getTime() / 1000;
  }
  if (at < EARLIEST || at > now + AHEAD) return 'absurd-date';
  return null;
}

const fresh = (): Cursor => ({ phase: 'backfill', until: null, newest: 0, syncedAt: 0, backfilledAt: 0 });

export async function ingest(sources: IngestSource[], deps: IngestDeps): Promise<IngestReport> {
  const report: IngestReport = { read: 0, kept: 0, deletions: 0, dropped: {} };
  const drop = (reason: string) => { report.dropped[reason] = (report.dropped[reason] ?? 0) + 1; };

  // Inclusive paging reads the oldest second of a page twice.
  const seen = new Set<string>();
  const take = (found: Found[], stream: 'events' | 'deletions') => {
    for (const f of found) {
      if (seen.has(f.event.id)) continue;
      seen.add(f.event.id);
      report.read += 1;
      if (stream === 'deletions') {
        if (f.event.kind === 5 && signed(f.event)) report.deletions += deps.store.applyDeletion(f.event, deps.now);
        continue;
      }
      if (deps.skip(f.event)) {
        drop('ours');
        continue;
      }
      const reason = acceptable(f.event, deps.now);
      if (reason) {
        drop(reason);
        continue;
      }
      const result = deps.store.put(f, deps.now);
      if (result === 'new' || result === 'newer') report.kept += 1;
    }
  };

  for (const source of sources) {
    for (const stream of ['events', 'deletions'] as const) {
      let cursor = deps.store.cursor(source.url, stream) ?? fresh();
      if (cursor.phase === 'sync' && deps.now - cursor.backfilledAt >= RESCAN_EVERY) cursor = { ...cursor, phase: 'backfill', until: null };
      if (cursor.phase === 'sync' && deps.now - cursor.syncedAt < SYNC_EVERY) continue;
      const since = cursor.phase === 'sync' ? Math.max(0, cursor.newest - SYNC_OVERLAP) : undefined;
      let until: number | null = cursor.phase === 'backfill' ? cursor.until : null;
      let finished = false;
      let answered = true;
      for (let page = 0; page < PAGES_PER_STEP; page += 1) {
        if (page > 0) await deps.pause?.();
        const filter: Filter = { ...STREAMS[stream], limit: PAGE };
        if (until !== null) filter.until = until;
        if (since !== undefined) filter.since = since;
        if (source.search) filter.search = 'include:spam';
        let result;
        try {
          result = await deps.reader.query([source.url], filter);
        } catch (error) {
          deps.log(`ingest ${source.url}: ${(error as Error).message}`);
          answered = false;
          break;
        }
        if (result.answered.length === 0) {
          answered = false;
          break;
        }
        take(result.found, stream);
        const times = result.found.map((f) => f.event.created_at);
        if (times.length) cursor.newest = Math.max(cursor.newest, ...times);
        if (times.length === 0 || (since !== undefined && times.length < PAGE)) {
          finished = true;
          break;
        }
        // Paging is inclusive of the oldest second seen, so events sharing it
        // are not skipped; a page that does not get past it moves on.
        const oldest = Math.min(...times);
        until = until !== null && oldest >= until ? until - 1 : oldest;
      }
      if (!answered) continue;
      if (cursor.phase === 'backfill') {
        cursor = finished ? { ...cursor, phase: 'sync', until: null, syncedAt: deps.now, backfilledAt: deps.now } : { ...cursor, until };
      } else if (finished) {
        cursor = { ...cursor, syncedAt: deps.now };
      }
      deps.store.setCursor(source.url, stream, cursor);
    }
  }
  return report;
}
