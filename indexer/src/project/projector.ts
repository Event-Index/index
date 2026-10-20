// One poll of a calendar the index publishes as its organizer, to the events
// their key publishes: the projections that are new or changed, its kind 31924
// calendar, and withdrawals (republished as cancelled, or deleted). The caller signs and
// publishes them, then records each with the store's markPublished.

import type { NormalizedFeed } from '../normalize/normalize.ts';
import type { IndexDb, Published } from '../store/index-db.ts';
import { reconcilePoll, observe, type PresenceState, type QuarantineReason } from '../rules/presence.ts';
import { resolveCohosts, listingsOf } from '../rules/dedupe.ts';
import { capPerCalendar, spreadCreatedAt, MAX_PER_SECOND } from '../rules/limits.ts';
import { occurrences, projectionWindow, type Occurrence } from './window.ts';
import { projectOccurrence, projectionContext, API_BASE, CANCELLED_PREFIX, type EventTemplate, type Tag } from './nip52.ts';
import { calendarList, deletionFor, type ListedEvent } from './profile.ts';
import { projectionHash } from './hash.ts';

export interface CohostPlan {
  // Listings (`<calendar d>\0<event d>`) that yield to another calendar,
  // with the d of the calendar that signs instead.
  yields: Map<string, string>;
  // The co-host calendars of each signing listing.
  cohostsOf: Map<string, string[]>;
  // Events a calendar co-hosts but does not sign, for its 31924.
  cohosted: Map<string, Array<{ signerD: string; kind: number; d: string; start: number }>>;
  // A co-host's copy (by public id) to the URL of the record it duplicates.
  canonicalOf: Map<string, string>;
}

const listingKey = (calendarD: string, d: string) => `${calendarD}\u0000${d}`;

// The other calendars (by d) listing an event this calendar signs.
export function cohostsIn(plan: CohostPlan, calendarD: string, eventD: string): string[] {
  return plan.cohostsOf.get(listingKey(calendarD, eventD)) ?? [];
}

export function expand(feed: NormalizedFeed, now: number, log: string[] = []): Occurrence[] {
  const window = projectionWindow(now);
  return feed.records.flatMap((r) => {
    const result = occurrences(r, window, { calendarD: feed.context.d, floatingZone: feed.calendar.timezone });
    if (result.error) log.push(`expansion ${r.uid}: ${result.error}`);
    return result.items;
  });
}

// The occurrences a calendar can project: within the per-calendar cap, and
// with a title. Only these enter co-host resolution, so an event never yields
// to a copy that will not be published.
export function projectable(feed: NormalizedFeed, now: number, log: string[] = []): Occurrence[] {
  const { kept, dropped } = capPerCalendar(expand(feed, now, log));
  if (dropped > 0) log.push(`cap: ${dropped} occurrences past the per-calendar limit`);
  return kept.filter((o) => {
    if (String(o.event.getFirstPropertyValue('summary') ?? '').trim()) return true;
    log.push(`skip ${o.record.uid}: no-summary`);
    return false;
  });
}

// Co-hosts across every directory calendar the index polls.
export function cohostPlan(feeds: NormalizedFeed[], now: number): CohostPlan {
  const plan: CohostPlan = { yields: new Map(), cohostsOf: new Map(), cohosted: new Map(), canonicalOf: new Map() };
  const listings = feeds.flatMap((f) => {
    const all = projectable(f, now);
    return listingsOf(f, (record) => all.filter((o) => o.record === record));
  });
  for (const resolution of resolveCohosts(listings)) {
    if (resolution.cohosts.length === 0) continue;
    const { canonical } = resolution;
    plan.cohostsOf.set(listingKey(canonical.calendarD, canonical.d), resolution.cohosts);
    for (const duplicate of resolution.duplicates) {
      plan.yields.set(listingKey(duplicate.calendarD, duplicate.d), canonical.calendarD);
      plan.canonicalOf.set(duplicate.id, `${API_BASE}/events/byid/${canonical.id}`);
      const list = plan.cohosted.get(duplicate.calendarD) ?? [];
      list.push({ signerD: canonical.calendarD, kind: canonical.kind ?? 31923, d: canonical.d, start: canonical.start });
      plan.cohosted.set(duplicate.calendarD, list);
    }
  }
  return plan;
}

export interface ProjectorInput {
  feed: NormalizedFeed;
  calendarPubkey: string;
  indexPubkey: string;
  // A co-host's key; null for a calendar that has none, which is left out.
  keyOf: (calendarD: string) => string | null;
  db: IndexDb;
  now: number;
  // Whether an event address has RSVPs (read from the relays).
  hasRsvps: (address: string) => boolean;
  plan: CohostPlan;
  perSecond?: number;
  // The calendar the index publishes as its organizer: their own profile and
  // relay list are left alone, the calendar's d is the entry's, and events
  // name the relay they are on.
  delegated: { relay: string; calendarD: string };
  // The address of an organizer's own event an occurrence copies.
  originalOf?: (id: string) => string | null;
}

export interface Planned {
  template: EventTemplate & { created_at: number };
  // What to record with markPublished once the signed event is out.
  record: Omit<Published, 'eventId'>;
}

export interface ProjectorResult {
  publish: Planned[];
  // Withdrawals, recorded with the store's markWithdrawn once published.
  withdrawn: Array<{ address: string; kind: number; d: string; status: 'cancelled' | 'deleted' }>;
  presence: PresenceState;
  quarantine: QuarantineReason | null;
  log: string[];
}

interface Candidate {
  template: EventTemplate;
  kind: number;
  d: string;
  start: number;
  // Deletions are always sent; everything else only when its hash changed.
  always?: boolean;
}

export function cancelledCopy(template: EventTemplate): EventTemplate {
  const tags = template.tags.map((t): Tag => (t[0] === 'title' && !t[1]!.startsWith(CANCELLED_PREFIX) ? ['title', `${CANCELLED_PREFIX}${t[1]}`] : [...t]));
  return { ...template, tags };
}

export function projectFeed(input: ProjectorInput): ProjectorResult {
  const { feed, db, now, calendarPubkey: pubkey } = input;
  const log: string[] = [];
  const presence = db.loadPresence(feed.context.d);
  if (feed.context.role !== 'calendar') return { publish: [], withdrawn: [], presence, quarantine: null, log };

  const kept = projectable(feed, now, log);

  const context = {
    ...projectionContext(feed, { calendarPubkey: pubkey, indexPubkey: input.indexPubkey }),
    relay: input.delegated.relay,
    ...(input.originalOf ? { originalOf: input.originalOf } : {}),
  };
  const projected: Array<{ o: Occurrence; template: EventTemplate }> = [];
  const yielded = new Set<string>();
  const yieldedTo = new Map<string, { uid: string; signer: string }>();
  for (const o of kept) {
    const key = listingKey(feed.context.d, o.d);
    const signer = input.plan.yields.get(key);
    if (signer) {
      const coordinate = `${o.allDay ? 31922 : 31923}:${o.d}`;
      yielded.add(coordinate);
      yieldedTo.set(coordinate, { uid: o.record.uid, signer });
      continue;
    }
    const cohosts = (input.plan.cohostsOf.get(key) ?? []).map(input.keyOf).filter((k): k is string => !!k);
    const result = projectOccurrence(o, { ...context, cohosts });
    if ('skip' in result) {
      log.push(`skip ${o.record.uid}: ${result.skip}`);
      continue;
    }
    projected.push({ o, template: result.template });
  }

  const address = (coordinate: string) => {
    const [kind, d] = coordinate.split(':');
    return `${kind}:${pubkey}:${d}`;
  };
  const decision = reconcilePoll(presence, { at: now, ok: true, seen: observe(projected.map((p) => p.o)), yielded }, (c) => input.hasRsvps(address(c)));
  if (decision.quarantine) {
    log.push(`quarantine: ${decision.quarantine}`);
    return { publish: [], withdrawn: [], presence: decision.state, quarantine: decision.quarantine, log };
  }

  const candidates: Candidate[] = projected.map(({ o, template }) => ({ template, kind: template.kind, d: o.d, start: o.start }));
  const withdrawn: ProjectorResult['withdrawn'] = [];
  for (const w of decision.withdraw) {
    const moved = yieldedTo.get(w.coordinate);
    if (moved) {
      log.push(`yield ${moved.uid} to ${moved.signer}: copy deleted, ${input.hasRsvps(address(w.coordinate)) ? 'with' : 'without'} RSVPs`);
    }
    const [kindText, d] = w.coordinate.split(':') as [string, string];
    const kind = Number(kindText);
    const last = db.lastTemplate(pubkey, kind, d) as EventTemplate | null;
    const start = db.projection(pubkey, kind, d)?.start ?? now;
    if (w.action === 'cancel' && last) {
      candidates.push({ template: cancelledCopy(last), kind, d, start });
      withdrawn.push({ address: address(w.coordinate), kind, d, status: 'cancelled' });
    } else {
      candidates.push({ template: deletionFor({ versions: db.versions(pubkey, kind, d), coordinate: address(w.coordinate), kind }), kind: 5, d, start, always: true });
      withdrawn.push({ address: address(w.coordinate), kind, d, status: 'deleted' });
    }
  }

  const name = feed.calendar.name ?? feed.context.d;
  const listed: ListedEvent[] = [
    ...projected.map(({ o, template }) => ({ coordinate: `${template.kind}:${pubkey}:${o.d}`, start: o.start })),
    ...(input.plan.cohosted.get(feed.context.d) ?? []).flatMap((c) => {
      const signer = input.keyOf(c.signerD);
      return signer ? [{ coordinate: `${c.kind}:${signer}:${c.d}`, start: c.start }] : [];
    }),
  ];
  const listD = input.delegated.calendarD;
  candidates.push({
    template: calendarList({ name, description: feed.calendar.description, now, items: listed, d: listD, relay: input.delegated.relay }),
    kind: 31924, d: listD, start: now,
  });

  const due = candidates
    .map((c) => ({ ...c, hash: projectionHash(c.template) }))
    .filter((c) => c.always || db.shouldPublish(pubkey, c.kind, c.d, c.hash));
  const createdAt = spreadCreatedAt(
    due.map((c) => ({ key: `${c.kind}:${c.d}`, last: c.always ? null : db.lastCreatedAt(pubkey, c.kind, c.d) })),
    now,
    input.perSecond ?? MAX_PER_SECOND,
  );
  const publish = due.map((c): Planned => {
    const at = createdAt.get(`${c.kind}:${c.d}`)!;
    return {
      template: { ...c.template, created_at: at },
      record: { pubkey, kind: c.kind, d: c.d, hash: c.hash, createdAt: at, start: c.start, template: c.template },
    };
  });
  return { publish, withdrawn, presence: decision.state, quarantine: null, log };
}
