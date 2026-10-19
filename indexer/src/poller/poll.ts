// One poll of one directory entry: fetch, normalize, project, sign with the
// calendar's key, publish, and record what was published.

import ICAL from 'ical.js';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { DirectoryIdentity } from '../directory/id.ts';
import { normalizeFeed, FeedParseError, type NormalizedFeed } from '../normalize/normalize.ts';
import { projectFeed, cohostPlan, expand, type CohostPlan } from '../project/projector.ts';
import { annotate, claimDate, naddrFor, type Annotation } from '../project/annotate.ts';
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
  // The key each other calendar signs with, for co-host tags; null for one
  // that has none.
  keyOf?: (calendarD: string) => string | null;
  // No calendar key is made: a calendar without one is read and its records
  // kept, but nothing is projected or signed for it.
  keyless?: boolean;
  // The calendar key signs only deletions: what else changed is held, and
  // published at the first poll after (which reads the feed in full).
  deletionsOnly?: boolean;
  // The address of a record's event item, when the index lists events as
  // items: its X-EVENTINDEX-NOSTR, in place of the calendar key's event.
  itemAddress?: (recordId: string) => string | null;
  // The address of an organizer's own event an occurrence copies.
  originalOf?: (id: string) => string | null;
  // A calendar published as its organizer: no profile or relay list of
  // theirs is written, its calendar's d is the entry's d, and its events
  // name the relay they are on.
  delegated?: {
    relay: string;
    claimedAt?: number | null;
    // A remote signer answers slowly: at most this many events are signed in
    // one poll, within the time budget; the rest wait for the next poll.
    batch?: number;
    budgetMs?: number;
  };
}

// How long one poll may spend signing through a remote signer.
export const SIGN_BUDGET_MS = 120_000;
// How soon a poll that left events unsigned comes back.
export const RESUME_AFTER = 60;

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

  const effectivePlan = typeof plan === 'function' ? plan(feed) : plan ?? cohostPlan([feed], now);
  const claimed = claimDate(deps.delegated?.claimedAt);
  // The records, as the API serves them, with what was published of each.
  const keepRecords = (pubkey: string | null, relay: string) => {
    for (const record of feed.records) {
      const notes = new Map<string, Annotation>();
      if (claimed) for (const vevent of record.component.getAllSubcomponents('vevent')) notes.set(String(vevent.getFirstPropertyValue('x-eventindex-id') ?? ''), { claimed });
      const single = record.master && !record.master.hasProperty('rrule') && !record.master.hasProperty('rdate');
      if (single && deps.itemAddress) {
        const item = deps.itemAddress(record.id);
        if (item) notes.set(record.id, { nostr: item });
      } else if (single && pubkey) {
        const kind = (record.master!.getFirstPropertyValue('dtstart') as ICAL.Time).isDate ? 31922 : 31923;
        const d = nostrD(record.uid);
        if (deps.db.projection(pubkey, kind, d)) notes.set(record.id, { ...notes.get(record.id), nostr: naddrFor(pubkey, kind, d, relay ? [relay] : []) });
      }
      const canonical = effectivePlan.canonicalOf.get(record.id);
      if (canonical) notes.set(record.id, { ...notes.get(record.id), canonical });
      annotate(record, notes);
      deps.db.putRecord({ calendarD: entry.d, uid: record.uid, id: record.id, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
    }
  };

  if (deps.keyless && !deps.delegated && !deps.vault.pubkeyFor(entry.d)) {
    keepRecords(null, '');
    success(feed.calendar.refreshInterval, nextEventStart, validators);
    return {
      status: 'published', published: 0, withdrawn: 0, quarantine: null, log: feed.log.map((l) => `${l.code} ${l.uid ?? ''} ${l.detail ?? ''}`.trim()),
      feed, plan: effectivePlan, text: fetched.text,
    };
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
  const previous = deps.db.loadPresence(entry.d);
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
    ...(deps.originalOf ? { originalOf: deps.originalOf } : {}),
  });

  // Everything in a batch is signed before anything is sent, so a signer
  // that stops answering half-way publishes nothing. Through a remote signer
  // a poll signs one batch, within a time budget; the rest is signed at the
  // next poll, which comes back soon.
  const toSign = deps.deletionsOnly && !deps.delegated ? result.publish.filter((p) => p.template.kind === 5) : result.publish;
  const holding = toSign.length < result.publish.length;
  const limit = deps.delegated?.batch ?? Infinity;
  const until = deps.delegated ? Date.now() + (deps.delegated.budgetMs ?? SIGN_BUDGET_MS) : Infinity;
  const signed: Array<{ planned: (typeof result.publish)[number]; event: VerifiedEvent }> = [];
  let unfinished = false;
  try {
    for (const planned of toSign) {
      if (signed.length >= limit || Date.now() > until) {
        unfinished = true;
        break;
      }
      signed.push({ planned, event: await signer.sign(planned.template) });
    }
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
  // An unfinished poll keeps the presence state as it was, so its
  // withdrawals are decided again, and sent, at the next poll.
  if (!unfinished) {
    for (const w of result.withdrawn) if (w.status === 'deleted') deps.db.markWithdrawn(pubkey, w.kind, w.d, 'deleted');
    let presence = result.presence;
    if (holding) {
      // A cancellation that was held is decided again at the next poll.
      const events = { ...presence.events };
      for (const w of result.withdrawn) {
        const coordinate = `${w.kind}:${w.d}`;
        if (w.status === 'cancelled' && previous.events[coordinate]) events[coordinate] = previous.events[coordinate]!;
      }
      presence = { ...presence, events };
    }
    deps.db.savePresence(entry.d, presence);
  }

  keepRecords(pubkey, relay);

  success(feed.calendar.refreshInterval, nextEventStart, validators);
  // The rest is signed at the next poll, which reads the feed in full even
  // if it has not changed.
  if (unfinished) deps.db.savePollState(entry.d, { ...deps.db.pollState(entry.d), etag: null, lastModified: null, nextPollAt: now + RESUME_AFTER });
  // What was held is published once its key may sign again, from the feed read in full.
  else if (holding) deps.db.savePollState(entry.d, { ...deps.db.pollState(entry.d), etag: null, lastModified: null });
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
