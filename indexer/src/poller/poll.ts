// One poll of one directory entry: fetch, normalize, project, sign with the
// calendar's key, publish, and record what was published.

import ICAL from 'ical.js';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { DirectoryIdentity } from '../directory/id.ts';
import { normalizeFeed, FeedParseError, type NormalizedFeed } from '../normalize/normalize.ts';
import { projectFeed, cohostPlan, expand, type CohostPlan } from '../project/projector.ts';
import { annotate, naddrFor, type Annotation } from '../project/annotate.ts';
import { INDEX_RELAY } from '../project/nip52.ts';
import { nostrD } from '../project/ids.ts';
import { nextPollAt, isStale } from '../rules/schedule.ts';
import type { QuarantineReason } from '../rules/presence.ts';
import type { IndexDb } from '../store/index-db.ts';
import type { Vault } from '../store/vault-db.ts';
import type { FetchResult, Validators } from './fetch.ts';
import { vaultSigner, type Signer } from '../claim/signer.ts';

export interface Entry extends DirectoryIdentity {
  entryName: string | null;
}

export interface PollDeps {
  db: IndexDb;
  vault: Vault;
  indexPubkey: string;
  now: () => number;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  publish: (events: VerifiedEvent[]) => Promise<void>;
  // Addresses of the calendar key's events that have RSVPs.
  rsvps: (pubkey: string) => Promise<Set<string>>;
  // The general relays the index publishes to, if any.
  generalRelays?: string[];
  // Who signs the calendar's events, asked once its feed has been read; by
  // default its calendar key, created on first use.
  signer?: () => Promise<Signer>;
  // The key each other calendar signs with, for co-host tags.
  keyOf?: (calendarD: string) => string;
  // A calendar published as its organizer: no profile or relay list of
  // theirs is written, its calendar's d is the entry's d, and its events
  // name the relay they are on.
  delegated?: { relay: string };
}

export type PollReport =
  | { status: 'published'; published: number; withdrawn: number; quarantine: QuarantineReason | null; log: string[]; feed: NormalizedFeed; plan: CohostPlan; text: string }
  | { status: 'not-modified' }
  | { status: 'aggregator'; feed: NormalizedFeed; text: string }
  | { status: 'failed'; code: string };

// The co-host plan for this poll: given, built from the fresh feed (with the
// other calendars the caller knows), or for this calendar alone.
export type PlanSource = CohostPlan | ((feed: NormalizedFeed) => CohostPlan) | null;

function failed(entry: Entry, deps: PollDeps, code: string, retryAfter: number | null = null): PollReport {
  const now = deps.now();
  const state = deps.db.pollState(entry.d);
  const failures = state.failures + 1;
  const firstFailureAt = state.firstFailureAt ?? now;
  deps.db.savePollState(entry.d, {
    ...state,
    failures,
    firstFailureAt,
    nextPollAt: nextPollAt({ now, refreshInterval: null, nextEventStart: null, failures, retryAfter }),
    stale: isStale({ now, firstFailureAt }),
  });
  return { status: 'failed', code };
}

export async function pollCalendar(entry: Entry, plan: PlanSource, deps: PollDeps): Promise<PollReport> {
  const now = deps.now();
  const state = deps.db.pollState(entry.d);
  const fetched = await deps.fetch(entry.feedUrl, { etag: state.etag, lastModified: state.lastModified });
  if (fetched.status === 'error') return failed(entry, deps, fetched.code, fetched.retryAfter ?? null);

  const success = (refreshInterval: number | null, nextEventStart: number | null, validators: Validators) =>
    deps.db.savePollState(entry.d, {
      etag: validators.etag ?? null,
      lastModified: validators.lastModified ?? null,
      failures: 0,
      firstFailureAt: null,
      lastSuccessAt: now,
      nextPollAt: nextPollAt({ now, refreshInterval, nextEventStart, failures: 0, retryAfter: null }),
      stale: false,
      refreshInterval,
      nextEventStart,
    });

  if (fetched.status === 'not-modified') {
    const next = state.nextEventStart !== undefined && state.nextEventStart !== null && state.nextEventStart >= now ? state.nextEventStart : null;
    success(state.refreshInterval ?? null, next, state);
    return { status: 'not-modified' };
  }

  let feed;
  try {
    feed = normalizeFeed(fetched.text, { ...entry, calendarAddress: `39999:${deps.indexPubkey}:${entry.d}` });
  } catch (error) {
    if (error instanceof FeedParseError) return failed(entry, deps, 'not-icalendar');
    throw error;
  }
  const occurrences = expand(feed, now);

  const nextEventStart = occurrences.map((o) => o.start).filter((s) => s >= now).sort((a, b) => a - b)[0] ?? null;
  const validators = { etag: fetched.etag, lastModified: fetched.lastModified };

  if (entry.role !== 'calendar') {
    success(feed.calendar.refreshInterval, nextEventStart, validators);
    return { status: 'aggregator', feed, text: fetched.text };
  }

  let signer: Signer;
  try {
    signer = deps.signer ? await deps.signer() : vaultSigner(deps.vault, entry.d, deps.vault.createKey(entry.d));
  } catch {
    return failed(entry, deps, 'signer');
  }
  const pubkey = signer.pubkey;
  const relay = deps.delegated?.relay ?? INDEX_RELAY;
  const rsvps = await deps.rsvps(pubkey);
  const effectivePlan = typeof plan === 'function' ? plan(feed) : plan ?? cohostPlan([feed], now);
  const result = projectFeed({
    feed,
    calendarPubkey: pubkey,
    indexPubkey: deps.indexPubkey,
    keyOf: deps.keyOf ?? ((d) => deps.vault.pubkeyFor(d) ?? deps.vault.createKey(d)),
    db: deps.db,
    now,
    hasRsvps: (address) => rsvps.has(address),
    plan: effectivePlan,
    generalRelays: deps.generalRelays ?? [],
    ...(deps.delegated ? { delegated: { relay, calendarD: entry.d } } : {}),
  });

  // Everything is signed before anything is sent, so a signer that stops
  // answering half-way publishes nothing.
  const signed: Array<{ planned: (typeof result.publish)[number]; event: VerifiedEvent }> = [];
  try {
    for (const planned of result.publish) signed.push({ planned, event: await signer.sign(planned.template) });
  } catch {
    return failed(entry, deps, 'signer');
  }
  try {
    await deps.publish(signed.map((s) => s.event));
  } catch {
    return failed(entry, deps, 'publish');
  }
  for (const { planned, event } of signed) {
    if (planned.template.kind !== 5) deps.db.markPublished({ ...planned.record, eventId: event.id });
  }
  for (const w of result.withdrawn) if (w.status === 'deleted') deps.db.markWithdrawn(pubkey, w.kind, w.d, 'deleted');
  deps.db.savePresence(entry.d, result.presence);

  for (const record of feed.records) {
    const notes = new Map<string, Annotation>();
    const single = record.master && !record.master.hasProperty('rrule') && !record.master.hasProperty('rdate');
    if (single) {
      const kind = (record.master!.getFirstPropertyValue('dtstart') as ICAL.Time).isDate ? 31922 : 31923;
      const d = nostrD(record.uid);
      if (deps.db.projection(pubkey, kind, d)) notes.set(record.id, { nostr: naddrFor(pubkey, kind, d, relay ? [relay] : []) });
    }
    const canonical = effectivePlan.canonicalOf.get(record.id);
    if (canonical) notes.set(record.id, { ...notes.get(record.id), canonical });
    annotate(record, notes);
    deps.db.putRecord({ calendarD: entry.d, uid: record.uid, id: record.id, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
  }

  success(feed.calendar.refreshInterval, nextEventStart, validators);
  return {
    status: 'published',
    published: signed.length,
    withdrawn: result.withdrawn.length,
    quarantine: result.quarantine,
    log: [...feed.log.map((l) => `${l.code} ${l.uid ?? ''} ${l.detail ?? ''}`.trim()), ...result.log],
    feed,
    plan: effectivePlan,
    text: fetched.text,
  };
}
