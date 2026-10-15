// Duplicates across directory calendars. Two listings are one event when
// they share a UID and a start, or an event URL and a start. One calendar
// signs it: the one whose name is the event's organizer name, else the one
// with the lowest d. The others are co-hosts. The rule is deterministic, so a
// rebuild gives the same answer.

import type { EventRecord, NormalizedFeed } from '../normalize/normalize.ts';
import type { Occurrence } from '../project/window.ts';

export interface Listing {
  calendarD: string;
  calendarName: string | null;
  uid: string;
  url: string | null;
  start: number;
  organizer: string | null;
  d: string;
  id: string;
  kind?: number;
}

export interface Resolution {
  canonical: Listing;
  // The other calendars listing the event, by d.
  cohosts: string[];
  // Every listing that yields to the canonical one.
  duplicates: Listing[];
}

function organizerOf(o: Occurrence): string | null {
  const property = o.event.getFirstProperty('organizer');
  const cn = property?.getParameter('cn');
  if (typeof cn === 'string' && cn.trim()) return cn.trim();
  const value = String(property?.getFirstValue() ?? '').trim();
  return value && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : null;
}

export function listingsOf(feed: NormalizedFeed, expand: (record: EventRecord) => Occurrence[]): Listing[] {
  if (feed.context.role !== 'calendar') return [];
  return feed.records.flatMap((record) =>
    expand(record).map((o) => ({
      calendarD: feed.context.d,
      calendarName: feed.calendar.name,
      uid: record.uid,
      url: (o.event.getFirstPropertyValue('url') as string | null) ?? null,
      start: o.start,
      organizer: organizerOf(o),
      d: o.d,
      id: o.id,
      kind: o.allDay ? 31922 : 31923,
    })),
  );
}

function normalName(name: string | null): string {
  return (name ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.toString().replace(/\/(\?|$)/, '$1');
  } catch {
    return url.trim().toLowerCase();
  }
}

const byKey = (a: Listing, b: Listing): number =>
  a.calendarD < b.calendarD ? -1 : a.calendarD > b.calendarD ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : a.start - b.start;

export function resolveCohosts(input: Listing[]): Resolution[] {
  const listings = [...input].sort(byKey);
  const parent = listings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const first = new Map<string, number>();
  listings.forEach((listing, i) => {
    const keys = [`uid\u0000${listing.uid}\u0000${listing.start}`];
    if (listing.url) keys.push(`url\u0000${normalUrl(listing.url)}\u0000${listing.start}`);
    for (const key of keys) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, i);
      else union(seen, i);
    }
  });

  const groups = new Map<number, Listing[]>();
  listings.forEach((listing, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), listing]);
  });

  return [...groups.values()].map((members) => {
    const organizers = new Set(members.map((m) => normalName(m.organizer)).filter(Boolean));
    const named = members.filter((m) => organizers.has(normalName(m.calendarName)));
    const canonical = (named.length > 0 ? named : members)[0]!;
    const cohosts = [...new Set(members.map((m) => m.calendarD))].filter((d) => d !== canonical.calendarD).sort();
    return { canonical, cohosts, duplicates: members.filter((m) => m !== canonical) };
  });
}
