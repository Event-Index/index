// What a maintainer does by hand: file the seed lists, review submitted feeds
// and remove requests, and see how the index is doing. Nothing here needs a
// key; the poll service publishes what these change.

import { identify } from '../directory/id.ts';
import { seedFeedUrl, type Seed } from '../directory/seed.ts';
import { encodeGeohash } from '../project/geohash.ts';
import type { IndexDb } from '../store/index-db.ts';
import type { DirectoryStore } from '../store/directory.ts';
import type { QueueStore } from '../store/queues.ts';
import type { EventStore } from '../store/events.ts';

export interface AdminStores {
  db: IndexDb;
  dir: DirectoryStore;
  queues: QueueStore;
  events: EventStore;
}

export interface City {
  name: string;
  slug: string;
  country: string;
  geonames_id: number;
  latitude: number;
  longitude: number;
  // The city's IANA zone, for showing times of events that carry none.
  timezone?: string;
}

export interface Cities {
  cities: City[];
}

// A calendar's usual area: precision 4 (about 39 km by 20 km).
const AREA_PRECISION = 4;

function area(city: City): { location: string; g: string } {
  return { location: `${city.name}, ${city.country}`, g: encodeGeohash(city.latitude, city.longitude, AREA_PRECISION) };
}

export function importSeeds(s: AdminStores, seeds: Seed[], cities: Cities, now: number): { filed: string[]; existing: string[]; blocked: string[] } {
  const report = { filed: [] as string[], existing: [] as string[], blocked: [] as string[] };
  for (const seed of seeds) {
    const city = cities.cities.find((c) => c.geonames_id === seed.geonames_id);
    if (!city) throw new Error(`no city with geonames id ${seed.geonames_id} in cities.json`);
    const { location, g } = area(city);
    for (const item of seed.calendars) {
      const id = typeof item === 'string' ? item : item.id;
      const foundVia = (typeof item === 'string' ? undefined : item.found_via) ?? seed.found_via ?? null;
      const identity = identify(seedFeedUrl(seed.source, id));
      if (s.dir.doNotIndex(identity.d)) {
        report.blocked.push(identity.d);
        continue;
      }
      const added = s.dir.add({
        d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
        name: null, description: null, image: null, location, g, foundVia, addedAt: now,
      });
      (added ? report.filed : report.existing).push(identity.d);
    }
  }
  return report;
}

export function approveSubmission(s: AdminStores, id: number, options: { city?: string }, cities: Cities, now: number): { d: string } {
  const submission = s.queues.submission(id);
  if (!submission || submission.status !== 'pending') throw new Error(`submission ${id} is not pending`);
  if (s.dir.doNotIndex(submission.d)) throw new Error(`${submission.d} is on the do-not-index list`);
  if (s.dir.get(submission.d)) throw new Error(`${submission.d} is already in the directory`);
  let place = { location: null as string | null, g: null as string | null };
  if (options.city) {
    const city = cities.cities.find((c) => c.slug === options.city);
    if (!city) throw new Error(`no city ${options.city} in cities.json`);
    place = area(city);
  }
  const identity = identify(submission.feedUrl);
  s.dir.add({
    d: submission.d, role: submission.role, source: submission.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
    name: submission.name, description: null, image: null, ...place, foundVia: 'submission', addedAt: now,
  });
  s.queues.resolveSubmission(id, 'approved', now, 'maintainer');
  return { d: submission.d };
}

export function rejectSubmission(s: AdminStores, id: number, now: number): void {
  const submission = s.queues.submission(id);
  if (!submission || submission.status !== 'pending') throw new Error(`submission ${id} is not pending`);
  s.queues.resolveSubmission(id, 'rejected', now);
}

function pendingRemoval(s: AdminStores, id: number) {
  const request = s.queues.removal(id);
  if (!request || request.status !== 'pending') throw new Error(`remove request ${id} is not pending`);
  return request;
}

// The poll service carries out an approved request on its next tick.
export function approveRemoval(s: AdminStores, id: number, now: number): void {
  pendingRemoval(s, id);
  s.queues.resolveRemoval(id, 'approved', now);
}

export function rejectRemoval(s: AdminStores, id: number, now: number): void {
  pendingRemoval(s, id);
  s.queues.resolveRemoval(id, 'rejected', now);
}

// Takes back an approval the index made itself: the calendar is removed as
// at its organizer's request (indexer rules § 10), which keeps it out.
export function undoApproval(s: AdminStores, id: number, now: number): { id: number } {
  const submission = s.queues.submission(id);
  if (!submission || submission.status !== 'approved' || submission.approvedBy !== 'auto') throw new Error(`submission ${id} is not an approval by the index`);
  const removal = removeCalendar(s, submission.d, 'auto-approval undone', now);
  s.queues.resolveSubmission(id, 'undone', now);
  return removal;
}

// A removal the maintainer starts (an organizer who wrote in), approved at once.
export function removeCalendar(s: AdminStores, nameOrD: string, message: string | null, now: number): { id: number } {
  const entry = s.dir.byLocalName(nameOrD) ?? s.dir.get(nameOrD);
  if (!entry || entry.removed) throw new Error(`no calendar ${nameOrD} in the directory`);
  const { id } = s.queues.requestRemoval({ d: entry.d, message, at: now });
  s.queues.resolveRemoval(id, 'approved', now);
  return { id };
}

export function status(s: AdminStores, now: number) {
  const all = s.dir.list({ includeRemoved: true });
  const listed = all.filter((e) => !e.removed);
  const polls = listed.map((e) => ({ d: e.d, state: s.db.pollState(e.d) }));
  const dump = s.dir.fact('dump_at');
  return {
    indexPubkey: s.dir.fact('index_pubkey'),
    calendars: listed.filter((e) => e.role === 'calendar').length,
    aggregators: listed.filter((e) => e.role === 'aggregator').length,
    removed: all.length - listed.length,
    withKey: listed.filter((e) => e.pubkey).length,
    stale: polls.filter((p) => p.state.stale).map((p) => p.d),
    neverPolled: polls.filter((p) => p.state.lastSuccessAt === null).length,
    upcomingEvents: s.events.countUpcoming(now),
    pendingSubmissions: s.queues.submissions('pending').length,
    pendingRemovals: s.queues.removals('pending').length,
    lastDump: dump ? Number(dump) : null,
  };
}
