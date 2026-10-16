// What a maintainer does by hand: file the seed lists, review submitted feeds
// and remove requests, and see how the index is doing. Nothing here needs a
// key; the poll service publishes what these change.

import { identify } from '../directory/id.ts';
import { seedFeedUrl, type Seed } from '../directory/seed.ts';
import type { Source } from '../types.ts';
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
  // Its Luma Discover page, an aggregator: the place's id and the page's slug.
  luma_discover?: string;
  luma_slug?: string;
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

// The hand-kept list of venues and communities (seeds/communities.json).
export interface Community {
  name: string;
  // A city's slug in cities.json.
  city: string;
  source: Source;
  // A platform id (a Luma calendar id, a Meetup group), or a feed URL.
  id?: string;
  feed?: string;
  // For a native publisher (source nostr): its own key.
  pubkey?: string;
  organization?: string;
  note?: string;
  found_via: string;
}

export interface Communities {
  communities: Community[];
}

// Files each community with a calendar feed under its city's area. A native
// publisher is only listed: it publishes its own events and gets no key here.
export function importCommunities(s: AdminStores, list: Communities, cities: Cities, now: number) {
  const report = { filed: [] as string[], existing: [] as string[], blocked: [] as string[], native: [] as string[] };
  for (const c of list.communities) {
    if (c.source === 'nostr') {
      report.native.push(c.name);
      continue;
    }
    const city = cities.cities.find((x) => x.slug === c.city);
    if (!city) throw new Error(`no city ${c.city} in cities.json (${c.name})`);
    const identity = identify(c.feed ?? seedFeedUrl(c.source, c.id!));
    if (s.dir.doNotIndex(identity.d)) {
      report.blocked.push(identity.d);
      continue;
    }
    const added = s.dir.add({
      d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
      name: null, description: null, image: null, ...area(city), foundVia: c.found_via, addedAt: now,
    });
    (added ? report.filed : report.existing).push(identity.d);
  }
  return report;
}

// Files each city's Luma Discover page as an aggregator, with the page that
// discovery reads (service/discovery.ts) and the city's area. `only` names
// cities by slug or by the page's slug.
export function importAggregators(s: AdminStores, cities: Cities, now: number, only?: string[]) {
  const report = { filed: [] as string[], existing: [] as string[], blocked: [] as string[] };
  for (const name of only ?? []) {
    if (!cities.cities.some((c) => c.luma_discover && (c.slug === name || c.luma_slug === name))) throw new Error(`no city or Luma page ${name} in cities.json`);
  }
  for (const city of cities.cities) {
    if (!city.luma_discover || (only && !only.includes(city.slug) && !only.includes(city.luma_slug ?? ''))) continue;
    if (!city.luma_slug) throw new Error(`${city.slug}: a Luma Discover page needs its luma_slug`);
    const identity = identify(`https://api.luma.com/ics/get?entity=discover&id=${city.luma_discover.replace(/^luma:/, '')}`);
    if (s.dir.doNotIndex(identity.d)) {
      report.blocked.push(identity.d);
      continue;
    }
    const added = s.dir.add({
      d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: `https://luma.com/${city.luma_slug}`,
      name: null, description: null, image: null, ...area(city), foundVia: 'luma:discover', addedAt: now,
    });
    (added ? report.filed : report.existing).push(identity.d);
  }
  return report;
}

export function approveSubmission(s: AdminStores, id: number, options: { city?: string }, cities: Cities, now: number): { d: string } {
  const submission = s.queues.submission(id);
  if (!submission || submission.status !== 'pending') throw new Error(`submission ${id} is not pending`);
  if (s.dir.doNotIndex(submission.d)) throw new Error(`${submission.d} is on the do-not-index list`);
  if (s.dir.get(submission.d)) throw new Error(`${submission.d} is already in the directory`);
  let place = { location: null as string | null, g: null as string | null };
  const slug = options.city ?? submission.city;
  if (slug) {
    const city = cities.cities.find((c) => c.slug === slug);
    if (!city) throw new Error(`no city ${slug} in cities.json`);
    place = area(city);
  }
  if (submission.source === 'nostr') {
    // A calendar its organizer publishes on nostr, filed by its key.
    const owner = submission.d.slice('nostr:'.length);
    s.dir.add({
      d: submission.d, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: submission.name, description: null, image: null,
      ...place, foundVia: 'owner', addedAt: now, mode: 'own', owner,
    });
    s.queues.resolveSubmission(id, 'approved', now);
    return { d: submission.d };
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

function pendingClaim(s: AdminStores, id: number) {
  const claim = s.queues.claim(id);
  if (!claim || claim.kind !== 'claim' || claim.status !== 'pending') throw new Error(`claim ${id} is not pending`);
  return claim;
}

// The poll service carries out an approved claim on its next tick. A claim
// is approved only once its organizer has shown control of the calendar
// (the token in its feed, or NIP-05 at its domain); their key they proved
// when they made it.
export function approveClaim(s: AdminStores, id: number, now: number): void {
  const claim = pendingClaim(s, id);
  if (!claim.verifiedAt) throw new Error(`claim ${id}: its organizer has not shown control of the calendar yet`);
  const entry = s.dir.get(claim.d);
  if (!entry || entry.removed || entry.mode !== 'mirrored') throw new Error(`claim ${id}: ${claim.d} is no longer a mirrored calendar`);
  s.queues.resolveClaim(id, 'approved', now);
}

export function rejectClaim(s: AdminStores, id: number, now: number): void {
  pendingClaim(s, id);
  s.queues.resolveClaim(id, 'rejected', now);
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
    pendingClaims: s.queues.claims('pending').length,
    lastDump: dump ? Number(dump) : null,
  };
}
