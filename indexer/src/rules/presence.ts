// What a successful poll means for the events a calendar has published.
//
// - An upcoming event is withdrawn only after it is missing from 3
//   consecutive successful polls spanning at least 24 hours (2 polls when it
//   starts within 24 hours). Feeds flap.
// - A poll that returns no events while upcoming events were present, or in
//   which more than half of at least 4 upcoming events are gone (their UIDs
//   absent, not merely moved), quarantines the feed: nothing is published or
//   withdrawn. The quarantine lifts when the feed recovers, or after 7 days,
//   when the smaller feed is accepted and the missing events start counting.
// - An event the calendar now leaves to a co-host to sign is deleted at once.
// - A withdrawn event with RSVPs is republished as cancelled; one without is
//   deleted.
// - An event whose address changes (a single event that becomes recurring,
//   or a timed one that becomes all-day) is withdrawn at the old address at
//   once.
// - Past events are left alone, and forgotten once they leave the window.

import type { Occurrence } from '../project/window.ts';
import { WINDOW_PAST } from '../project/window.ts';

export const MISSES_TO_WITHDRAW = 3;
export const MISSING_SPAN = 24 * 3600;
export const QUARANTINE_ACCEPT_AFTER = 7 * 86400;
export const HALF_DROP_MINIMUM = 4;
export const NEAR_START = 24 * 3600;
export const MISSES_NEAR_START = 2;

export interface Seen {
  // `<kind>:<d>`; the calendar key completes the address.
  coordinate: string;
  uid: string;
  recurring: boolean;
  start: number;
}

export interface Tracked {
  uid: string;
  recurring: boolean;
  start: number;
  missed: number;
  firstMissedAt: number | null;
}

export type QuarantineReason = 'empty' | 'dropped-half';

export interface PresenceState {
  events: Record<string, Tracked>;
  quarantine: { reason: QuarantineReason; since: number } | null;
}

export interface Poll {
  at: number;
  // A poll that failed (network, HTTP or parse error) is not a successful poll.
  ok: boolean;
  seen: Seen[];
  // Coordinates the calendar no longer signs because a co-host does.
  yielded?: Set<string>;
}

export interface Withdrawal {
  coordinate: string;
  action: 'cancel' | 'delete';
}

export interface PollDecision {
  state: PresenceState;
  publish: string[];
  withdraw: Withdrawal[];
  quarantine: QuarantineReason | null;
}

export function emptyPresence(): PresenceState {
  return { events: {}, quarantine: null };
}

export function observe(items: Occurrence[]): Seen[] {
  return items.map((o) => ({
    coordinate: `${o.allDay ? 31922 : 31923}:${o.d}`,
    uid: o.record.uid,
    recurring: o.occurrence !== null,
    start: o.start,
  }));
}

const dOf = (coordinate: string): string => coordinate.slice(coordinate.indexOf(':') + 1);

function quarantineReason(state: PresenceState, poll: Poll, seen: Set<string>): QuarantineReason | null {
  const yielded = poll.yielded ?? new Set<string>();
  // The upcoming events present at the last successful poll and still this
  // calendar's to sign.
  const baseline = Object.entries(state.events).filter(([c, t]) => t.missed === 0 && t.start >= poll.at && !yielded.has(c));
  if (baseline.length === 0) return null;
  if (poll.seen.length === 0) return 'empty';
  // Gone means the event's UID is absent; a moved occurrence is not gone.
  const uids = new Set(poll.seen.map((s) => s.uid));
  const dropped = baseline.filter(([coordinate, t]) => !seen.has(coordinate) && !uids.has(t.uid)).length;
  if (baseline.length >= HALF_DROP_MINIMUM && dropped > baseline.length / 2) return 'dropped-half';
  return null;
}

export function reconcilePoll(state: PresenceState, poll: Poll, hasRsvps: (coordinate: string) => boolean): PollDecision {
  if (!poll.ok) return { state, publish: [], withdraw: [], quarantine: state.quarantine?.reason ?? null };

  const seen = new Map(poll.seen.map((s) => [s.coordinate, s]));
  const reason = quarantineReason(state, poll, new Set(seen.keys()));
  if (reason) {
    const since = state.quarantine?.since ?? poll.at;
    if (poll.at - since < QUARANTINE_ACCEPT_AFTER) {
      return { state: { ...state, quarantine: { reason, since } }, publish: [], withdraw: [], quarantine: reason };
    }
  }

  const events: Record<string, Tracked> = {};
  const withdraw: Withdrawal[] = [];
  const byUid = new Map<string, Seen[]>();
  for (const s of poll.seen) byUid.set(s.uid, [...(byUid.get(s.uid) ?? []), s]);

  for (const [coordinate, tracked] of Object.entries(state.events)) {
    if (seen.has(coordinate)) continue;
    if (tracked.start < poll.at) {
      if (tracked.start >= poll.at - WINDOW_PAST) events[coordinate] = tracked;
      continue;
    }
    if (poll.yielded?.has(coordinate)) {
      // The event lives on, signed by its co-host: this copy goes.
      withdraw.push({ coordinate, action: 'delete' });
      continue;
    }
    const sameUid = byUid.get(tracked.uid) ?? [];
    const moved = sameUid.some((s) => s.recurring !== tracked.recurring || dOf(s.coordinate) === dOf(coordinate));
    const missed = tracked.missed + 1;
    const firstMissedAt = tracked.firstMissedAt ?? poll.at;
    const gone = (missed >= MISSES_TO_WITHDRAW && poll.at - firstMissedAt >= MISSING_SPAN)
      || (missed >= MISSES_NEAR_START && tracked.start - poll.at < NEAR_START);
    if (moved || gone) {
      withdraw.push({ coordinate, action: hasRsvps(coordinate) ? 'cancel' : 'delete' });
    } else {
      events[coordinate] = { ...tracked, missed, firstMissedAt };
    }
  }
  for (const s of poll.seen) {
    events[s.coordinate] = { uid: s.uid, recurring: s.recurring, start: s.start, missed: 0, firstMissedAt: null };
  }

  withdraw.sort((a, b) => (a.coordinate < b.coordinate ? -1 : 1));
  return { state: { events, quarantine: null }, publish: [...seen.keys()], withdraw, quarantine: null };
}
