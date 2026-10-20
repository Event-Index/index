// The poll service's work, one tick at a time: carry out approved removals
// and claims, poll the calendars that are due, keep the events table and the
// directory on nostr up to date, and write the daily dump.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import ICAL from 'ical.js';
import { dirname } from 'node:path';
import { finalizeEvent, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import type { Settings } from '../config.ts';
import type { DirectoryIdentity } from '../directory/id.ts';
import { directoryEntry, eventsHeader, citySlug } from '../directory/entry.ts';
import { adapterFor } from '../adapters/index.ts';
import { recordFromText, type CalendarMeta, type NormalizedFeed } from '../normalize/normalize.ts';
import { pollCalendar } from '../poller/poll.ts';
import type { FetchResult, Validators } from '../poller/fetch.ts';
import { cohostPlan, cohostsIn, projectable, type CohostPlan } from '../project/projector.ts';
import { deletionFor, INDEX_NAME } from '../project/profile.ts';
import { geoOf, imageOf, locationsOf, summaryOf, venueHidden, type EventTemplate } from '../project/nip52.ts';
import { encodeGeohash } from '../project/geohash.ts';
import { projectionHash } from '../project/hash.ts';
import { spreadCreatedAt } from '../rules/limits.ts';
import { makeDump } from '../store/dump.ts';
import type { IndexDb } from '../store/index-db.ts';
import type { Vault } from '../store/vault-db.ts';
import { ownershipClash, type DirectoryStore, type StoredEntry } from '../store/directory.ts';
import type { QueueStore } from '../store/queues.ts';
import type { EventRow, EventStore } from '../store/events.ts';
import type { Filter } from 'nostr-tools/filter';
import { setsFor, type RelaySet } from './routing.ts';
import { createDiscovery } from './discovery.ts';
import { discoveredStore } from '../store/discovered.ts';
import { eventItem } from '../project/items.ts';
import { itemStore } from '../store/items.ts';
import type { City } from './admin.ts';
import { outsideRelay, readAuthor, type RelayReader } from '../native/read.ts';
import { ingest, acceptable, type IngestSource } from '../native/ingest.ts';
import { loadAggregators, PUBLIC_SECRET_KEYS, shortNpub } from '../native/publishers.ts';
import { nostrStore } from '../store/nostr-events.ts';
import { nativeD } from '../directory/id.ts';
import { occurrences, type Occurrence } from '../project/window.ts';
import type { NostrEvent } from '../native/record.ts';
import { inUidChunks, nativeFeed } from '../native/record.ts';
import { nextPollAt, isStale } from '../rules/schedule.ts';
import { API_BASE } from '../project/nip52.ts';
import { claimDate, naddrFor } from '../project/annotate.ts';
import { publicEventId, nostrD } from '../project/ids.ts';
import { nativeUid, type Found } from '../native/record.ts';
import { findCopies, AGGREGATOR, FEED, ORGANIZER, type Candidate } from '../rules/copies.ts';
import { WINDOW_PAST } from '../project/window.ts';
import type { AuthorRead } from '../native/read.ts';
import { limited, PERMISSIONS, type RemoteSession, type RemoteSigners } from '../claim/signer.ts';
import { authoredText, parseBunkerUrl } from '../claim/proof.ts';
import type { Claim } from '../store/queues.ts';
import type { SignerConnection } from '../store/vault-db.ts';

// Where an event goes: the index's own relay (always), or a set of outside
// relays (service/routing.ts).
export type Audience = 'own' | RelaySet;

export interface Publisher {
  // For `own`, resolves once the relay took the events, and a rejection fails
  // the poll so it is retried; outside sets are queued, for all of the set's
  // relays or only those named.
  publish(events: VerifiedEvent[], audience: Audience, relays?: string[]): Promise<void>;
  // Sends events to relays named for them (an organizer's own); resolves
  // once each event was taken by at least one of them.
  publishTo?(events: VerifiedEvent[], relays: string[]): Promise<void>;
  // Addresses of the key's events that have RSVPs, read from the index's
  // relay and any relays named.
  rsvps(pubkey: string, relays?: string[]): Promise<Set<string>>;
  // What the index's own relay holds, for re-sending to outside relays.
  fetchOwn?(filter: Filter): Promise<VerifiedEvent[]>;
  // Events still queued for outside relays that are not paused, and for one
  // outside relay.
  pending?(): number;
  pendingFor?(relay: string): number;
  close(): void;
}

export interface IndexerDeps {
  db: IndexDb;
  dir: DirectoryStore;
  queues: QueueStore;
  events: EventStore;
  vault: Vault;
  indexKey: Uint8Array;
  settings: Settings;
  now: () => number;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  publisher: Publisher;
  log: (line: string) => void;
  // Reads organizers' own events from relays (native and claimed calendars).
  reader?: RelayReader;
  // Whether a relay an organizer names may be used (default: a public wss
  // host, native/read.ts).
  relayAllowed?: (url: string) => Promise<boolean>;
  // Connects to organizers' remote signers (NIP-46).
  signers?: RemoteSigners;
  // Keys that publish other organizers' events (default:
  // seeds/nostr-aggregators.json).
  aggregators?: Set<string>;
  // A pause between pages read from a relay (none by default).
  pause?: () => Promise<void>;
  // The most events signed through a remote signer in one poll.
  signBatch?: number;
  maxPollsPerTick?: number;
  // The seeded cities (seeds/cities.json), for the zone of an event item.
  cities?: City[];
  // Event items signed in one tick, and created_at seconds they are spread over.
  itemsPerTick?: number;
  itemsPerSecond?: number;
  // Aborted on shutdown: the tick stops between polls.
  signal?: AbortSignal;
}

export interface TickReport {
  polled: string[];
  failed: string[];
  removed: string[];
  published: number;
}

const DAY = 86400;
const REMOVED = 'organizer request';
const RETIRED_KEY = 'a calendar key the index once held';
// The most events signed through an organizer's remote signer in one poll.
const SIGN_BATCH = 100;
// The index key's kinds re-sent from the index's relay when outside
// publishing starts, and the directory's, re-sent when it goes outside.
const BACKFILL_KINDS = [0, 3, 10002];
const DIRECTORY_KINDS = [39999];
// Bumped when what the backfill sends changes, so it runs again.
const BACKFILL_VERSION = '1';
// Feeds discovery checks in one tick.
const DISCOVERY_CHECKS_PER_TICK = 5;
// Event items: signed at most so many a tick, created_at spread so many a
// second; all of them looked at again this often; and one missing from its
// calendar this long is withdrawn (a feed may drop an event for a while).
const ITEMS_PER_TICK = 2000;
const ITEMS_PER_SECOND = 100;
const ITEMS_EVERY = 600;
const ITEM_MISSING_GRACE = DAY;

// No co-hosts: a native calendar's events are its organizer's own.
const NO_PLAN: CohostPlan = { yields: new Map(), cohostsOf: new Map(), cohosted: new Map(), canonicalOf: new Map() };

function identityOf(entry: StoredEntry): DirectoryIdentity {
  return { d: entry.d, role: entry.role, source: entry.source, feedUrl: entry.feedUrl, pageUrl: entry.pageUrl };
}

function metaOf(entry: StoredEntry, stored: unknown): CalendarMeta {
  const meta = (stored ?? {}) as Partial<CalendarMeta>;
  return {
    name: entry.name ?? meta.name ?? null,
    nameSource: meta.nameSource ?? null,
    platformDefault: meta.platformDefault ?? false,
    description: entry.description ?? meta.description ?? null,
    url: entry.pageUrl ?? meta.url ?? null,
    image: entry.image ?? meta.image ?? null,
    color: meta.color ?? null,
    refreshInterval: meta.refreshInterval ?? null,
    timezone: meta.timezone ?? null,
  };
}

// The events table's rows for one calendar's projectable occurrences.
export function eventRows(feed: NormalizedFeed, plan: CohostPlan, now: number): EventRow[] {
  return projectable(feed, now).map((o) => rowOf(feed, o, plan));
}

// Every occurrence a native calendar's records have, at any time: the
// index projects none of them, so no window or cap applies.
const ALL_TIME = { from: 0, to: 4102444800 };
export function nativeRows(feed: NormalizedFeed): EventRow[] {
  return feed.records
    .flatMap((record) => occurrences(record, ALL_TIME, { calendarD: feed.context.d }).items)
    .filter((o) => String(o.event.getFirstPropertyValue('summary') ?? '').trim())
    .map((o) => rowOf(feed, o, NO_PLAN));
}

function rowOf(feed: NormalizedFeed, o: Occurrence, plan: CohostPlan): EventRow {
  const adapter = adapterFor(feed.context.source);
  const hidden = venueHidden(o.event);
  const geo = hidden ? null : geoOf(o.event);
  return {
    id: o.id,
    calendarD: feed.context.d,
    recordId: o.record.id,
    uid: o.record.uid,
    d: o.d,
    kind: o.allDay ? 31922 : 31923,
    start: o.start,
    end: o.end,
    // A UTC time is in its venue's zone, where the record names it.
    tzid: (o.event.getFirstPropertyValue('x-eventindex-tzid') as string | null) ?? o.startTzid,
    title: String(o.event.getFirstPropertyValue('summary') ?? '').trim(),
    summary: summaryOf(o.event, adapter) || null,
    location: hidden ? null : locationsOf(o.event)[0] ?? null,
    g: geo ? encodeGeohash(geo[0], geo[1], 9) : null,
    tags: [...new Set(o.event.getAllProperties('categories').flatMap((p) => p.getValues()).map((v) => String(v).trim().toLowerCase()).filter(Boolean))],
    url: (o.event.getFirstPropertyValue('url') as string | null) ?? null,
    cancelled: o.cancelled,
    canonical: plan.canonicalOf.get(o.id)?.split('/').pop() ?? null,
    cohosts: cohostsIn(plan, feed.context.d, o.d),
  };
}

export function createIndexer(deps: IndexerDeps) {
  const { db, dir, queues, events, vault, settings, publisher } = deps;
  const indexPubkey = getPublicKey(deps.indexKey);
  dir.setFact('index_pubkey', indexPubkey);
  // What organizers seal their signer's connection to (claim/seal.ts).
  dir.setFact('intake_pubkey', vault.intakePubkey);
  const feeds = new Map<string, NormalizedFeed>();
  // The NIP-52 events read from relays, as their publishers signed them.
  const store = nostrStore(db);
  const aggregators = deps.aggregators ?? loadAggregators();
  const eventsHeaderAddress = `39998:${indexPubkey}:events`;
  // A relay list names only relays that hold the events: the general relays
  // while outside publishing is on, and for the curator, the list relays once
  // the directory goes outside.
  const generalRelays = settings.publishToGeneralRelays ? settings.generalRelays : [];
  const listRelays = settings.publishToGeneralRelays && settings.publishDirectoryOutside ? settings.listRelays : [];

  // The keys the relay accepts events from: the index key and, when the
  // operator has the relay host claimants, the keys of organizers the index
  // publishes as.
  const allowed = { hosted: new Set<string>() };
  for (const entry of dir.list()) {
    if (settings.hostClaimants && entry.mode === 'delegated' && entry.owner) allowed.hosted.add(entry.owner);
  }
  function writeAllowlist(): void {
    const file = settings.relayAllowlist;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const list = { index: indexPubkey, hosted: [...allowed.hosted].sort() };
      writeFileSync(`${file}.tmp`, `${JSON.stringify(list)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      deps.log(`relay allowlist: ${(error as Error).message}`);
    }
  }
  writeAllowlist();
  // The calendar keys the index once held are never read as publishers.
  for (const pubkey of db.retiredCalendarKeys()) {
    if (!dir.doNotIndex(nativeD(pubkey))) dir.block(nativeD(pubkey), RETIRED_KEY, deps.now());
  }

  const discovery = createDiscovery({
    dir,
    found: discoveredStore(db),
    fetch: deps.fetch,
    log: deps.log,
    settings: { perRun: settings.discoveryPerRun, perDay: settings.discoveryPerDay, checksPerStep: DISCOVERY_CHECKS_PER_TICK },
  });

  // Organizers the relay hosts: those of calendars the index publishes as,
  // while the operator has it host them.
  function rehost(): void {
    allowed.hosted.clear();
    if (settings.hostClaimants) {
      for (const entry of dir.list()) if (entry.mode === 'delegated' && entry.owner) allowed.hosted.add(entry.owner);
    }
    writeAllowlist();
  }

  // The co-host plan needs every calendar's events; until a calendar polls,
  // its stored records stand in for its feed.
  for (const entry of dir.list()) {
    if (entry.role !== 'calendar' || entry.mode === 'own') continue;
    const records = db.recordsOf(entry.d);
    if (records.length === 0) continue;
    try {
      feeds.set(entry.d, {
        context: { ...identityOf(entry), entryName: entry.name },
        calendar: metaOf(entry, dir.calendarMeta(entry.d)),
        records: records.map((r) => recordFromText(r.ics, r.uid, r.id)),
        zones: { resolved: new Map(), fromFeed: [], unknown: [] },
        log: [],
      });
    } catch (error) {
      deps.log(`stored records of ${entry.d}: ${(error as Error).message}`);
    }
  }

  // Sends signed events: to the index's relay, or, for events signed as an
  // organizer, to their own relays (`home`) and to the index's relay only
  // when it hosts claimants; then to the outside relays their kinds call for.
  async function send(signed: VerifiedEvent[], now: number, home?: string[], ownOnly = false): Promise<void> {
    if (signed.length === 0) return;
    if (home) {
      if (!publisher.publishTo) throw new Error('the publisher cannot send to an organizer\'s relays');
      if (home.length) await publisher.publishTo(signed, home);
      if (settings.hostClaimants) await publisher.publish(signed, 'own');
      else if (!home.length) throw new Error('no relay to publish the organizer\'s events to');
    } else {
      await publisher.publish(signed, 'own');
    }
    if (ownOnly) return;
    await sendOutside(signed, { indexPubkey, now, outside: settings.publishToGeneralRelays, directory: settings.publishDirectoryOutside });
  }

  async function sendOutside(signed: VerifiedEvent[], ctx: Parameters<typeof setsFor>[1]): Promise<void> {
    const bySet = new Map<RelaySet, VerifiedEvent[]>();
    for (const event of signed) {
      for (const set of setsFor(event, ctx)) {
        if (!bySet.has(set)) bySet.set(set, []);
        bySet.get(set)!.push(event);
      }
    }
    const results = await Promise.allSettled([...bySet].map(([set, events]) => publisher.publish(events, set)));
    for (const r of results) if (r.status === 'rejected') deps.log(`outside relays: ${(r.reason as Error).message}`);
  }

  // Every outside relay gets, once, what the index's relay already holds of
  // the kinds its set takes (through the same routing, no deletions), and the
  // directory's kinds once the directory goes outside. A relay is marked done
  // when its queue has drained; a restart before that sends it again, and a
  // relay added later gets it alone.
  const relaysOf: Record<RelaySet, string[]> = {
    search: settings.searchRelays, lists: settings.listRelays, profiles: settings.profileRelays, general: settings.generalRelays,
  };
  const inFlight = new Map<string, string>();
  async function maybeBackfill(now: number): Promise<void> {
    if (!settings.publishToGeneralRelays || !publisher.fetchOwn) return;
    for (const [fact, relay] of inFlight) {
      if ((publisher.pendingFor?.(relay) ?? 0) === 0) {
        dir.setFact(fact, BACKFILL_VERSION);
        inFlight.delete(fact);
        deps.log(`outside relays: backfill sent to ${relay}`);
      }
    }
    const needs = (prefix: string, relay: string) => {
      const fact = `${prefix} ${relay}`;
      return !inFlight.has(fact) && dir.fact(fact) !== BACKFILL_VERSION ? fact : null;
    };
    const plan = new Map<RelaySet, { relays: string[]; directory: string[] }>();
    const facts: Array<[string, string]> = [];
    for (const set of Object.keys(relaysOf) as RelaySet[]) {
      const entry = { relays: [] as string[], directory: [] as string[] };
      for (const relay of relaysOf[set]) {
        const fact = set !== 'lists' ? needs('outside_backfill', relay) : null;
        if (fact) { entry.relays.push(relay); facts.push([fact, relay]); }
        const dfact = settings.publishDirectoryOutside && (set === 'search' || set === 'lists') ? needs('outside_backfill_directory', relay) : null;
        if (dfact) { entry.directory.push(relay); facts.push([dfact, relay]); }
      }
      if (entry.relays.length || entry.directory.length) plan.set(set, entry);
    }
    if (plan.size === 0) return;
    const kinds = [...BACKFILL_KINDS, ...(settings.publishDirectoryOutside ? DIRECTORY_KINDS : [])];
    const ctx = { indexPubkey, now, outside: true, directory: settings.publishDirectoryOutside, backfill: true };
    const events = await publisher.fetchOwn({ authors: [indexPubkey], kinds, limit: 500 });
    const bySet = new Map<string, { set: RelaySet; relays: string[]; events: VerifiedEvent[] }>();
    for (const event of events) {
      if (event.kind === 39999 && !nostrEntriesGoOutside(event.tags.find((t) => t[0] === 'd')?.[1] ?? '')) continue;
      for (const set of setsFor(event, ctx)) {
        const entry = plan.get(set);
        if (!entry) continue;
        const relays = DIRECTORY_KINDS.includes(event.kind) ? entry.directory : entry.relays;
        if (relays.length === 0) continue;
        const key = `${set} ${relays.join(',')}`;
        if (!bySet.has(key)) bySet.set(key, { set, relays, events: [] });
        bySet.get(key)!.events.push(event);
      }
    }
    for (const { set, relays, events: batch } of bySet.values()) await publisher.publish(batch, set, relays);
    const count = events.length;
    for (const [fact, relay] of facts) inFlight.set(fact, relay);
    deps.log(`outside relays: backfill of ${count} events queued for ${[...new Set(facts.map(([, r]) => r))].join(', ')}`);
  }

  // Event items (spec/event-items.md): one per upcoming event of each
  // mirrored calendar, signed by the index key, republished when it changes,
  // withdrawn when its event leaves its calendar for a day or its calendar is
  // no longer mirrored, and left to expire once its event has ended.
  const items = itemStore(db);
  const cities = deps.cities ?? (JSON.parse(readFileSync(new URL('../../../seeds/cities.json', import.meta.url), 'utf8')) as { cities: City[] }).cities;
  let itemsDueAt = 0;
  // A calendar removed or claimed has its items looked at in the same tick.
  const itemsSoon = () => { itemsDueAt = 0; };
  const mirrored = (e: StoredEntry) => e.role === 'calendar' && e.source !== 'nostr' && e.mode === 'mirrored' && !e.removed && !dir.doNotIndex(e.d);
  function recordImage(recordId: string, uid: string): string | null {
    const stored = db.record(recordId);
    if (!stored) return null;
    try {
      const master = recordFromText(stored.ics, uid, recordId).master;
      return master ? imageOf(master) : null;
    } catch {
      return null;
    }
  }
  async function publishItems(now: number): Promise<number> {
    if (!settings.eventItems || !settings.eventsHeader || now < itemsDueAt) return 0;
    const header = settings.eventsHeader;
    const chosen = settings.eventItemsCalendars;
    const listed = dir.list().filter((e) => mirrored(e) && (!chosen || chosen.has(e.d)));
    const wanted = new Map<string, { template: EventTemplate; d: string; start: number; ends: number; expires: number; calendarD: string }>();
    for (const entry of listed) {
      const calendar = { d: entry.d, name: entry.name, source: entry.source, feedUrl: entry.feedUrl, location: entry.location, owner: entry.owner };
      const images = adapterFor(entry.source).policy.images;
      for (const row of events.ongoing(entry.d, now)) {
        const built = eventItem(row, { header, indexPubkey, calendar, cities, image: images ? recordImage(row.recordId, row.uid) : null });
        if ('skip' in built) continue;
        wanted.set(row.id, { template: built.template, d: row.id, start: row.start, ends: built.ends, expires: built.expires, calendarD: entry.d });
      }
    }
    const kept = new Set(listed.map((e) => e.d));
    const withdrawals: Array<{ template: EventTemplate; d: string; start: number; always: true }> = [];
    for (const live of items.all()) {
      if (wanted.has(live.d)) {
        if (live.missingSince !== null) items.present(live.d);
        continue;
      }
      // Relays drop it once it expires (NIP-40); an ended event is left to it.
      if (live.expiresAt < now) items.forget(live.d);
      if (live.endsAt < now) continue;
      if (kept.has(live.calendarD)) {
        items.missing(live.d, now);
        if (now - (live.missingSince ?? now) < ITEM_MISSING_GRACE) continue;
      }
      withdrawals.push({
        template: deletionFor({ versions: db.versions(indexPubkey, 39999, live.d), coordinate: `39999:${indexPubkey}:${live.d}`, kind: 39999 }),
        d: live.d, start: now, always: true,
      });
    }
    const perTick = deps.itemsPerTick ?? ITEMS_PER_TICK;
    let due = [...wanted.values()].filter((w) => db.shouldPublish(indexPubkey, 39999, w.d, projectionHash(w.template)));
    // Under a cap, a live item is kept up to date, and a new one waits for room.
    if (settings.eventItemsMax !== null) {
      let room = Math.max(0, settings.eventItemsMax - (items.count() - withdrawals.length));
      due = due.filter((w) => items.has(w.d) || (room > 0 && room-- > 0));
    }
    const batch = due.slice(0, perTick);
    const sign = (t: EventTemplate & { created_at: number }) => finalizeEvent(t, deps.indexKey);
    const published = await publishAs(indexPubkey, sign, [...withdrawals, ...batch.map(({ template, d, start }) => ({ template, d, start }))], now, deps.itemsPerSecond ?? ITEMS_PER_SECOND);
    for (const w of withdrawals) {
      db.markWithdrawn(indexPubkey, 39999, w.d, 'deleted');
      items.forget(w.d);
    }
    for (const b of batch) items.put({ d: b.d, calendarD: b.calendarD, endsAt: b.ends, expiresAt: b.expires });
    // What was published before and has not changed is still tracked.
    for (const w of wanted.values()) if (!items.has(w.d) && !db.shouldPublish(indexPubkey, 39999, w.d, projectionHash(w.template))) items.put({ d: w.d, calendarD: w.calendarD, endsAt: w.ends, expiresAt: w.expires });
    if (published) deps.log(`event items: ${batch.length} published, ${withdrawals.length} withdrawn, ${due.length - batch.length} to come, ${items.count()} live`);
    itemsDueAt = due.length > batch.length ? now : now + ITEMS_EVERY;
    return published;
  }

  // Signs templates (hash-tracked unless `always`) with created_at moving
  // forward per address, sends them, and records them.
  async function publishAs(
    pubkey: string,
    sign: (t: EventTemplate & { created_at: number }) => VerifiedEvent,
    items: Array<{ template: EventTemplate; d: string; start: number; always?: boolean }>,
    now: number,
    perSecond?: number,
    ownOnly = false,
  ): Promise<number> {
    const due = items
      .map((i) => ({ ...i, hash: projectionHash(i.template) }))
      .filter((i) => i.always || db.shouldPublish(pubkey, i.template.kind, i.d, i.hash));
    if (due.length === 0) return 0;
    const times = spreadCreatedAt(due.map((i) => ({ key: `${i.template.kind}:${i.d}`, last: i.always ? null : db.lastCreatedAt(pubkey, i.template.kind, i.d) })), now, perSecond);
    const signed = due.map((i) => ({ i, event: sign({ ...i.template, created_at: times.get(`${i.template.kind}:${i.d}`)! }) }));
    await send(signed.map((s) => s.event), now, undefined, ownOnly);
    for (const { i, event } of signed) {
      if (!i.always) db.markPublished({ pubkey, kind: i.template.kind, d: i.d, hash: i.hash, eventId: event.id, createdAt: event.created_at, start: i.start, template: i.template });
    }
    return signed.length;
  }

  // The calendars list's header is a maintainer's: the index key is its
  // curator and signs only the entries. A header it published itself before
  // is deleted, on its own relay, where alone it went.
  const header = settings.directoryHeader ?? `39998:${indexPubkey}:event-calendars`;
  async function retireOwnHeader(): Promise<void> {
    if (header === `39998:${indexPubkey}:event-calendars`) return;
    const own = db.projection(indexPubkey, 39998, 'event-calendars');
    if (!own || own.status !== 'live') return;
    const deletion = finalizeEvent({
      ...deletionFor({ versions: db.versions(indexPubkey, 39998, 'event-calendars'), coordinate: `39998:${indexPubkey}:event-calendars`, kind: 39998 }),
      created_at: Math.max(deps.now(), own.createdAt + 1),
    }, deps.indexKey);
    await publisher.publish([deletion], 'own');
    db.markWithdrawn(indexPubkey, 39998, 'event-calendars', 'deleted');
    deps.log('retired the index key\'s own event-calendars header');
  }

  // Where organizers' own events are read: the index's relay, and the
  // general and profile relays.
  const usualRelays = [...new Set([settings.relayUrl, ...settings.generalRelays, ...settings.profileRelays])];

  // A native or claimed calendar: its organizer's events, read by author.
  async function pollOwn(entry: StoredEntry, now: number, report: TickReport): Promise<void> {
    report.polled.push(entry.d);
    const state = db.pollState(entry.d);
    const fail = (code: string) => {
      report.failed.push(entry.d);
      const failures = state.failures + 1;
      const firstFailureAt = state.firstFailureAt ?? now;
      db.savePollState(entry.d, { ...state, failures, firstFailureAt, stale: isStale({ now, firstFailureAt }),
        nextPollAt: nextPollAt({ now, refreshInterval: null, nextEventStart: null, failures, retryAfter: null }) });
      deps.log(`read ${entry.d}: ${code}`);
    };
    if (!deps.reader || !entry.owner) return fail('no-reader');
    const read = await readOwner(entry.owner);
    if (!read.ok) return fail('no-relay-answered');
    applyOwnRead(entry, read, now);
  }

  function readOwner(owner: string): Promise<AuthorRead> {
    return readAuthor(deps.reader!, owner, usualRelays, deps.relayAllowed ? { relayAllowed: deps.relayAllowed } : {});
  }

  // What was read of an organizer becomes the calendar's records and events.
  function applyOwnRead(entry: StoredEntry, read: AuthorRead, now: number): void {
    const state = db.pollState(entry.d);
    dir.setOwnerRelays(entry.d, read.writeRelays);
    const newestCalendar = read.calendars[0];
    const nativeCalendar = newestCalendar ? `31924:${entry.owner}:${newestCalendar.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : null;
    dir.setOwnership(entry.d, { mode: entry.mode, owner: entry.owner, claimedAt: entry.claimedAt, nativeCalendar });
    // A calendar filed by its key is described by its organizer's profile; a
    // claimed one keeps what its feed said.
    if (entry.source === 'nostr') {
      const title = newestCalendar?.tags.find((t) => t[0] === 'title')?.[1]?.trim() || null;
      dir.setMeta(entry.d, {
        name: read.profile?.name ?? title ?? entry.name,
        description: newestCalendar?.content.trim() || read.profile?.about || null,
        url: read.profile?.website ?? null,
        image: read.profile?.picture ?? null,
      });
    }
    // What was read joins what ingestion keeps, and the calendar is built
    // from all of it.
    for (const deletion of read.deletions) store.applyDeletion(deletion, now);
    for (const found of read.events) if (!skipEvent(found.event) && !acceptable(found.event, now)) store.put(found, now);
    if (entry.owner) {
      store.markDirty(entry.owner, now);
      rebuildAuthor(entry.owner, now);
    }
    const nextEventStart = events.byCalendar(entry.d, now, now + 400 * DAY, 1)[0]?.start ?? null;
    db.savePollState(entry.d, { ...state, failures: 0, firstFailureAt: null, lastSuccessAt: now, stale: false, refreshInterval: null, nextEventStart,
      nextPollAt: nextPollAt({ now, refreshInterval: null, nextEventStart, failures: 0, retryAfter: null }) });
  }

  // Events never read into the index: what it signs itself (and any other
  // key's event that carries its events header, unless that key's organizer
  // owns a listed calendar: what the index signed as them is theirs), keys
  // whose secret is public, and publishers removed at their request or left
  // out, the calendar keys it once held among them.
  function skipEvent(event: NostrEvent): boolean {
    return event.pubkey === indexPubkey
      || PUBLIC_SECRET_KEYS.has(event.pubkey) || dir.doNotIndex(nativeD(event.pubkey))
      || (event.tags.some((t) => t[0] === 'z' && t[1] === eventsHeaderAddress) && !dir.isOwner(event.pubkey));
  }

  // The directory entry a publisher's events belong to: the calendar it
  // publishes itself (filed by its key, or claimed), else its own entry,
  // kept now when it has events to show (and listed once one is upcoming).
  // None for a key the index publishes as, or one it leaves out.
  function entryFor(pubkey: string, now: number, list: boolean): StoredEntry | null {
    const owned = dir.byOwner(pubkey).filter((e) => !e.removed);
    const own = owned.find((e) => e.mode === 'own');
    if (own) return own;
    if (owned.length || PUBLIC_SECRET_KEYS.has(pubkey)) return null;
    const d = nativeD(pubkey);
    if (dir.doNotIndex(d)) return null;
    const existing = dir.get(d);
    if (existing && !existing.removed && aggregators.has(pubkey) && existing.role !== 'aggregator') {
      // A key added to the aggregators' list after it was listed.
      dir.setRole(d, 'aggregator');
      return dir.get(d);
    }
    if (existing) return existing.removed ? null : existing;
    if (!list || !settings.ingestNip52) return null;
    const profile = store.profile(pubkey);
    dir.add({
      d, role: aggregators.has(pubkey) ? 'aggregator' : 'calendar', source: 'nostr', feedUrl: '', pageUrl: profile?.website ?? null,
      name: profile?.name ?? shortNpub(pubkey), description: profile?.about ?? null, image: profile?.picture ?? null,
      location: null, g: null, foundVia: 'ingest', addedAt: now, mode: 'own', owner: pubkey, listed: false,
    });
    return dir.get(d);
  }

  // Builds a publisher's records and events from what the store keeps.
  function rebuildAuthor(pubkey: string, now: number): void {
    const stored = store.eventsOf(pubkey);
    const entry = entryFor(pubkey, now, stored.length > 0);
    if (entry) {
      const ctx = {
        d: entry.d, source: 'nostr' as const, role: 'calendar' as const, feedUrl: '', pageUrl: entry.pageUrl, entryName: entry.name,
        calendarName: entry.name, calendarAddress: `39999:${indexPubkey}:${entry.d}`, claimedAt: entry.claimedAt,
      };
      // A share at a time: a publisher of thousands of events (an aggregator)
      // built at once needs more memory than the service has.
      const rows: EventRow[] = [];
      for (const share of inUidChunks(stored, NATIVE_BUILD_SHARE)) {
        const feed = nativeFeed(share, ctx);
        for (const record of feed.records) {
          db.putRecord({ calendarD: entry.d, uid: record.uid, id: record.id, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
        }
        rows.push(...nativeRows(feed));
      }
      events.replaceCalendar(entry.d, rows);
      // Listed with its first upcoming event, and listed from then on.
      if (!entry.listed && events.hasUpcoming(entry.d, now)) {
        dir.setListed(entry.d);
        deps.log(`listed ${entry.d}${entry.role === 'aggregator' ? ' (aggregator)' : ''}`);
      }
      if (entry.foundVia === 'ingest') db.savePollState(entry.d, { ...db.pollState(entry.d), lastSuccessAt: now, failures: 0, firstFailureAt: null, stale: false });
    }
    store.built(pubkey);
  }

  const ingestSources = (): IngestSource[] => {
    const search = new Set(settings.ingestSearchRelays);
    return [...settings.ingestSearchRelays.map((url) => ({ url, search: true })), ...settings.ingestRelays.filter((u) => !search.has(u)).map((url) => ({ url, search: false }))];
  };

  // Reads what is new on the relays that carry NIP-52 events.
  async function ingestStep(now: number): Promise<void> {
    if (!settings.ingestNip52 || !deps.reader) return;
    const report = await ingest(ingestSources(), { reader: deps.reader, store, now, skip: skipEvent, log: deps.log, ...(deps.pause ? { pause: deps.pause } : {}) });
    if (report.read) {
      const dropped = Object.entries(report.dropped).map(([k, v]) => `${k} ${v}`).join(', ');
      deps.log(`ingest: read ${report.read}, kept ${report.kept}, deletions ${report.deletions}${dropped ? `, left out: ${dropped}` : ''}`);
    }
  }

  // Builds the records of publishers whose events changed, a share at a time.
  const BUILD_BUDGET_MS = 20_000;
// Events by uid built into records at once, for one publisher.
const NATIVE_BUILD_SHARE = 500;
  function rebuildDirty(now: number): void {
    const until = Date.now() + BUILD_BUDGET_MS;
    for (const pubkey of store.dirty(500)) {
      if (Date.now() > until) break;
      try {
        rebuildAuthor(pubkey, now);
      } catch (error) {
        deps.log(`build ${pubkey}: ${(error as Error).message}`);
        store.built(pubkey);
      }
    }
  }

  // Names listed publishers from their profiles (kind 0), checked weekly,
  // a batch at a time.
  const PROFILE_BATCH = 100;
  const PROFILE_EVERY = 7 * DAY;
  async function refreshProfiles(now: number): Promise<void> {
    if (!settings.ingestNip52 || !deps.reader) return;
    const due = dir.list({ includeUnlisted: true }).filter((e) => e.foundVia === 'ingest' && e.owner && now - (store.profile(e.owner)?.checkedAt ?? 0) >= PROFILE_EVERY)
      .slice(0, PROFILE_BATCH);
    if (!due.length) return;
    const authors = due.map((e) => e.owner!);
    const plain = [...new Set([...settings.profileRelays, ...settings.generalRelays, ...settings.ingestRelays])].filter((u) => !settings.ingestSearchRelays.includes(u));
    const found = [
      ...(plain.length ? (await deps.reader.query(plain, { kinds: [0], authors })).found : []),
      ...(settings.ingestSearchRelays.length ? (await deps.reader.query(settings.ingestSearchRelays, { kinds: [0], authors, search: 'include:spam' })).found : []),
    ];
    for (const entry of due) {
      const newest = found.filter((f) => f.event.pubkey === entry.owner && f.event.kind === 0)
        .sort((a, b) => b.event.created_at - a.event.created_at)[0];
      let profile: Record<string, unknown> | null = null;
      try {
        profile = newest ? JSON.parse(newest.event.content) as Record<string, unknown> : null;
      } catch {
        profile = null;
      }
      if (!profile) {
        store.checkedProfile(entry.owner!, now);
        continue;
      }
      const text = (key: string) => (typeof profile![key] === 'string' && (profile![key] as string).trim() ? (profile![key] as string).trim().slice(0, 500) : null);
      const p = { name: text('display_name') ?? text('name'), about: text('about'), picture: text('picture'), website: text('website'), createdAt: newest!.event.created_at };
      store.setProfile(entry.owner!, p, now);
      dir.setMeta(entry.d, { name: p.name ?? shortNpub(entry.owner!), description: p.about, url: p.website, image: p.picture });
    }
  }

  // Marks copies (rules/copies.ts) among the events from 30 days ago on: in
  // the events table, in each copy's record, and, for a mirrored feed's copy
  // of an organizer's own event, by polling its calendar again so its
  // projection names the original.
  function markCopies(now: number): void {
    const entries = new Map(dir.list({ includeUnlisted: true }).map((e) => [e.d, e]));
    const rankOf = (entry: StoredEntry): Candidate['rank'] => (entry.role === 'aggregator' ? AGGREGATOR : entry.mode === 'own' ? ORGANIZER : FEED);
    const rows = events.from(now - WINDOW_PAST).filter((r) => entries.has(r.calendarD));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const found = findCopies(rows.map((r) => ({ id: r.id, calendarD: r.calendarD, rank: rankOf(entries.get(r.calendarD)!), start: r.start, title: r.title, g: r.g })));
    const before = events.copies();
    const current = new Map<string, { originalId: string; originalAddress: string | null }>();
    const repoll = new Set<string>();
    for (const [copyId, originalId] of found) {
      const original = byId.get(originalId)!;
      const organizer = rankOf(entries.get(original.calendarD)!) === ORGANIZER;
      // A native record's UID is its event's address.
      current.set(copyId, { originalId, originalAddress: organizer ? original.uid : null });
    }
    for (const [copyId, original] of current) {
      const row = byId.get(copyId)!;
      if (row.canonical !== original.originalId) {
        events.setCanonical(copyId, original.originalId);
        markRecord(row, original.originalId, now);
      }
      const was = before.get(copyId);
      if (rankOf(entries.get(row.calendarD)!) === FEED && was?.originalAddress !== original.originalAddress) repoll.add(row.calendarD);
    }
    for (const [copyId, was] of before) {
      if (current.has(copyId)) continue;
      const row = byId.get(copyId) ?? events.byId(copyId);
      if (!row) continue;
      const entry = entries.get(row.calendarD);
      if (entry && rankOf(entry) === FEED) {
        // Its co-host facts and projection come back with a poll.
        repoll.add(row.calendarD);
        continue;
      }
      if (row.canonical === was.originalId) {
        events.setCanonical(copyId, null);
        markRecord(row, null, now);
      }
    }
    events.setCopies(current);
    for (const d of repoll) db.savePollState(d, { ...db.pollState(d), etag: null, lastModified: null, nextPollAt: 0 });
  }

  // Writes (or clears) X-EVENTINDEX-CANONICAL on a copy's record.
  function markRecord(row: EventRow, originalId: string | null, now: number): void {
    const stored = db.record(row.recordId);
    if (!stored) return;
    const record = recordFromText(stored.ics, stored.uid, row.recordId);
    for (const vevent of record.component.getAllSubcomponents('vevent')) {
      const id = String(vevent.getFirstPropertyValue('x-eventindex-id') ?? '');
      if (id !== row.id && !(id === row.recordId && record.overrides.length === 0)) continue;
      vevent.removeAllProperties('x-eventindex-canonical');
      if (originalId) vevent.addPropertyWithValue('x-eventindex-canonical', `${API_BASE}/events/byid/${originalId}`);
    }
    db.putRecord({ calendarD: row.calendarD, uid: stored.uid, id: row.recordId, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
  }

  // Whether a directory entry may go to the list and search relays: one the
  // index listed from what publishers post waits for the operator.
  function nostrEntriesGoOutside(d: string): boolean {
    const entry = dir.get(d);
    return settings.publishNostrEntriesOutside || !entry || !fromPosts(entry);
  }

  // A publisher listed without its organizer proving the key: found by
  // reading relays, or from a link someone pasted.
  function fromPosts(entry: StoredEntry): boolean {
    return entry.source === 'nostr' && entry.foundVia !== 'owner';
  }

  // The key each calendar's events are signed with, for co-host tags: its
  // organizer's, once they publish it; a mirrored calendar's events are
  // listed as items, and signed by no key of their own.
  function keyOf(calendarD: string): string | null {
    const entry = dir.get(calendarD);
    return entry && entry.mode !== 'mirrored' && entry.owner ? entry.owner : null;
  }

  // Where an organizer's events go when the index publishes as them: their
  // own write relays, else the general relays (none when the index's relay
  // hosts them), and the relay their events name.
  function homeOf(entry: StoredEntry): { relays: string[]; hint: string } {
    const relays = entry.ownerRelays.length ? entry.ownerRelays : settings.hostClaimants ? [] : settings.generalRelays;
    return { relays, hint: settings.hostClaimants ? settings.publicRelay : relays[0] ?? '' };
  }

  // The organizer's own event that one of the calendar's events stands for:
  // the same page, or the same start and title.
  function ownCopy(row: EventRow, own: Found[]): Found | null {
    const value = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1];
    const title = (text: string | null | undefined) => (text ?? '').replace(/^Cancelled: /, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return own.find((f) => (row.url && f.event.tags.some((t) => t[0] === 'r' && t[1] === row.url))
      || (value(f.event.tags, 'start') === String(row.start) && title(value(f.event.tags, 'title')) === title(row.title))) ?? null;
  }

  // Points an old record at the organizer's record that replaces it.
  function pointRecord(entry: StoredEntry, oldD: string, replacement: string, now: number): void {
    const stored = db.record(publicEventId(entry.d, oldD));
    if (!stored) return;
    const record = recordFromText(stored.ics, stored.uid, publicEventId(entry.d, oldD));
    for (const vevent of record.component.getAllSubcomponents('vevent')) {
      vevent.removeAllProperties('x-eventindex-canonical');
      vevent.removeAllProperties('x-eventindex-claimed');
      vevent.addPropertyWithValue('x-eventindex-canonical', `${API_BASE}/events/byid/${replacement}`);
      vevent.addPropertyWithValue('x-eventindex-claimed', claimDate(now)!);
    }
    db.putRecord({ calendarD: entry.d, uid: stored.uid, id: record.id, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
  }

  type Outcome = 'done' | 'retry' | { failed: string };

  // A calendar whose events are now signed by another key is polled at once,
  // its feed read in full: nothing it holds has been signed by that key yet.
  function pollAgain(d: string): void {
    db.savePollState(d, { ...db.pollState(d), etag: null, lastModified: null, nextPollAt: 0 });
  }

  // Connects to the signer a claimant sealed for the index, and checks it
  // signs as them.
  async function pair(claim: Claim): Promise<SignerConnection | { failed: string }> {
    if (!deps.signers || !claim.signer) return { failed: 'no signer was given' };
    let pointer;
    try {
      pointer = parseBunkerUrl(vault.unseal(claim.signer));
    } catch {
      pointer = null;
    }
    if (!pointer) return { failed: 'the signer\'s address could not be read' };
    const allowedRelay = deps.relayAllowed ?? ((url: string) => outsideRelay(url));
    const reachable: string[] = [];
    for (const relay of pointer.relays) if (await allowedRelay(relay)) reachable.push(relay);
    if (!reachable.length) return { failed: 'the signer\'s relays are not reachable by the index' };
    let paired;
    try {
      paired = await deps.signers.pair({ ...pointer, relays: reachable }, PERMISSIONS);
    } catch {
      return { failed: 'the signer did not answer' };
    }
    try {
      if (paired.session.pubkey !== claim.pubkey) return { failed: 'the signer signs for another key' };
    } finally {
      await paired.session.close().catch(() => {});
    }
    return paired.connection;
  }

  // The connection a claim made, when it is tried again (a signer's
  // one-time secret works once), else a new one.
  async function connectionFor(claim: Claim, entry: StoredEntry): Promise<SignerConnection | { failed: string }> {
    const saved = vault.connection(entry.d);
    if (saved && saved.owner === claim.pubkey && entry.mode !== 'delegated') {
      const { owner: _, ...connection } = saved;
      return connection;
    }
    const connection = await pair(claim);
    if ('failed' in connection) return connection;
    vault.saveConnection(entry.d, claim.pubkey, connection);
    return connection;
  }

  // "Verify and link": the index keeps mirroring the calendar and names the
  // organizer's key, on its entry and on each of its event items.
  async function claimLink(claim: Claim, entry: StoredEntry, now: number): Promise<Outcome> {
    dir.setOwnership(entry.d, { mode: 'mirrored', owner: claim.pubkey, claimedAt: now, nativeCalendar: null });
    itemsSoon();
    deps.log(`${entry.d}: its organizer's key is named, ${claim.pubkey.slice(0, 12)}…`);
    return 'done';
  }

  // "I publish myself": the index reads the organizer's own events.
  async function claimOwn(claim: Claim, entry: StoredEntry, now: number): Promise<Outcome> {
    if (!deps.reader) return { failed: 'the index cannot read relays' };
    const owner = claim.pubkey;
    const read = await readOwner(owner);
    if (!read.ok) return 'retry';
    const calendar = read.calendars[0];
    const ownerCalendar = calendar ? `31924:${owner}:${calendar.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : null;
    // The organizer's own copies of the calendar's upcoming events.
    const matched = new Map<string, Found>();
    for (const row of events.ongoing(entry.d, now)) {
      const copy = ownCopy(row, read.events);
      if (copy) matched.set(row.d, copy);
    }
    dir.setOwnership(entry.d, { mode: 'own', owner, claimedAt: now, nativeCalendar: ownerCalendar });
    itemsSoon();
    feeds.delete(entry.d);
    for (const [oldD, copy] of matched) pointRecord(entry, oldD, publicEventId(entry.d, nostrD(nativeUid(copy.event))), now);
    applyOwnRead(dir.get(entry.d)!, read, now);
    return 'done';
  }

  // "Publish for me, as me": the index signs with the organizer's key,
  // through their signer.
  async function claimDelegated(claim: Claim, entry: StoredEntry, now: number): Promise<Outcome> {
    const connection = await connectionFor(claim, entry);
    if ('failed' in connection) return connection;
    const owner = claim.pubkey;
    if (deps.reader) {
      const read = await readOwner(owner);
      if (read.ok) dir.setOwnerRelays(entry.d, read.writeRelays);
    }
    dir.setOwnership(entry.d, { mode: 'delegated', owner, claimedAt: now, nativeCalendar: `31924:${owner}:${entry.d}` });
    itemsSoon();
    rehost();
    // Its events go out as the organizer's at this tick's poll.
    pollAgain(entry.d);
    return 'done';
  }

  async function carryOut(claim: Claim, now: number): Promise<Outcome> {
    const entry = dir.get(claim.d);
    if (!entry || entry.removed || entry.role !== 'calendar') return { failed: 'the calendar is no longer in the directory' };
    if (claim.kind === 'claim') {
      if (entry.mode !== 'mirrored') return { failed: 'the calendar is already published by its organizer' };
      if (claim.mode === 'link') return claimLink(claim, entry, now);
      if (ownershipClash(dir.byOwner(claim.pubkey), entry.d, claim.mode ?? 'own')) return { failed: 'the organizer\'s key already publishes another calendar listed here' };
      return claim.mode === 'delegated' ? claimDelegated(claim, entry, now) : claimOwn(claim, entry, now);
    }
    if (entry.mode === 'mirrored' || entry.owner !== claim.pubkey) return { failed: 'only the calendar\'s organizer can change how it is published' };
    if (claim.kind === 'disconnect') {
      if (entry.mode !== 'delegated') return 'done';
      vault.forgetConnection(entry.d);
      dir.setOwnership(entry.d, { mode: 'own', owner: entry.owner, claimedAt: entry.claimedAt, nativeCalendar: null });
      rehost();
      feeds.delete(entry.d);
      if (deps.reader) {
        const read = await readOwner(entry.owner);
        if (read.ok) applyOwnRead(dir.get(entry.d)!, read, now);
      }
      deps.log(`${entry.d}: its organizer disconnected their signer`);
      return 'done';
    }
    if (!entry.feedUrl || entry.source === 'nostr') return { failed: 'the calendar has no feed to publish from' };
    if (ownershipClash(dir.byOwner(entry.owner), entry.d, 'delegated')) return { failed: 'the organizer\'s key already publishes another calendar listed here' };
    const connection = await connectionFor(claim, entry);
    if ('failed' in connection) return connection;
    dir.setOwnership(entry.d, { mode: 'delegated', owner: entry.owner, claimedAt: entry.claimedAt, nativeCalendar: `31924:${entry.owner}:${entry.d}` });
    rehost();
    pollAgain(entry.d);
    deps.log(`${entry.d}: its organizer connected a signer`);
    return 'done';
  }

  async function carryOutClaims(now: number): Promise<void> {
    for (const claim of queues.claims('approved')) {
      let outcome: Outcome;
      let waiting = 'no relay answered for the organizer for a day';
      try {
        outcome = await carryOut(claim, now);
      } catch (error) {
        deps.log(`claim ${claim.id} for ${claim.d}: ${(error as Error).stack ?? error}`);
        outcome = 'retry';
        waiting = 'the claim could not be carried out for a day';
      }
      // Tried again at each tick, for a day after its approval.
      if (outcome === 'retry') {
        if (claim.resolvedAt === null || now - claim.resolvedAt <= DAY) continue;
        outcome = { failed: waiting };
      }
      if (outcome === 'done') queues.resolveClaim(claim.id, 'done', now);
      else {
        // A connection made for a claim that did not go through is forgotten.
        const entry = dir.get(claim.d);
        if (claim.mode === 'delegated' && claim.kind !== 'disconnect' && entry && entry.mode !== 'delegated') vault.forgetConnection(claim.d);
        queues.resolveClaim(claim.id, 'failed', now, outcome.failed);
        deps.log(`claim ${claim.id} for ${claim.d}: ${outcome.failed}`);
      }
    }
  }

  async function publishDirectory(now: number): Promise<number> {
    const items: Array<{ template: EventTemplate; d: string; start: number }> = [
      {
        template: {
          kind: 0,
          tags: [],
          content: JSON.stringify({
            name: INDEX_NAME,
            about: `The open directory of public event calendars. Mirrors them as nostr calendars so any app can render them. ${settings.domain}`,
            // The mark on its blue tile (brand/); never a calendar's picture.
            picture: `https://${settings.domain}/brand/mark-tile-512.png`,
            website: `https://${settings.domain}`,
            nip05: `_@${settings.domain}`,
          }),
        },
        d: '',
        start: now,
      },
      { template: { kind: 10002, tags: [['r', settings.publicRelay], ...[...generalRelays, ...listRelays].map((r) => ['r', r, 'write'])], content: '' }, d: '', start: now },
      // Follows no one.
      { template: { kind: 3, tags: [], content: '' }, d: '', start: now },
      { template: eventsHeader(), d: 'events', start: now },
    ];
    // Entries listed from what publishers post stay on the index's relay
    // until the operator sends them outside; publishers kept without a
    // listing get none.
    const held: typeof items = [];
    let sending = 0;
    for (const entry of dir.list({ includeRemoved: true })) {
      // An entry names only the organizer's own key: a publisher's, or one
      // its organizer verified.
      const key = entry.owner;
      const outside = nostrEntriesGoOutside(entry.d);
      const template = directoryEntry({
        identity: identityOf(entry),
        calendar: metaOf(entry, dir.calendarMeta(entry.d)),
        header,
        pubkey: key,
        readFrom: entry.mode === 'own' ? 'nostr' : 'feed',
        nativeCalendar: entry.nativeCalendar,
        localName: entry.localName,
        location: entry.location,
        geohash: entry.g,
        city: citySlug(entry.location),
        removed: entry.removed ?? undefined,
      });
      (outside ? items : held).push({ template, d: entry.d, start: now });
      if (outside && fromPosts(entry) && db.shouldPublish(indexPubkey, 39999, entry.d, projectionHash(template))) sending += 1;
    }
    // The publishers' entries going to the list and search relays are
    // counted before they go.
    if (sending && settings.publishToGeneralRelays && settings.publishDirectoryOutside) {
      const all = dir.list({ includeUnlisted: true }).filter(fromPosts);
      const listed = all.filter((e) => e.listed).length;
      deps.log(`directory: sending ${sending} entr${sending === 1 ? 'y' : 'ies'} of nostr publishers to the list and search relays (${listed} listed, ${all.length - listed} kept without an entry)`);
    }
    await retireOwnHeader();
    // One second each, so a list relay reads them in order.
    const sign = (t: EventTemplate & { created_at: number }) => finalizeEvent(t, deps.indexKey);
    return await publishAs(indexPubkey, sign, items, now, 1) + await publishAs(indexPubkey, sign, held, now, 1, true);
  }

  // A removed calendar's items are withdrawn at once. One its organizer
  // publishes keeps its events, which are theirs; the index stops reading
  // them and forgets any signer of theirs.
  function removeCalendar(entry: StoredEntry, now: number): void {
    if (entry.mode !== 'mirrored') {
      vault.forgetConnection(entry.d);
      // The organizer is not listed again from what they post.
      if (entry.owner) {
        dir.block(nativeD(entry.owner), REMOVED, now);
        store.forget(entry.owner);
      }
    }
    dir.retire(entry.d, REMOVED, now);
    itemsSoon();
    if (entry.mode === 'delegated') rehost();
    events.removeCalendar(entry.d);
    feeds.delete(entry.d);
    deps.log(`removed ${entry.d}`);
  }

  function verifyTokens(d: string, feed: string, now: number): void {
    const text = authoredText(feed);
    for (const request of queues.openRemovalsFor(d)) {
      if (!request.verifiedAt && text.includes(request.token)) {
        queues.markVerified(request.id, now);
        deps.log(`remove request ${request.id} for ${d}: token found in the feed`);
      }
    }
    for (const claim of queues.openClaimsFor(d)) {
      if (!claim.verifiedAt && claim.token && text.includes(claim.token)) {
        queues.markClaimVerified(claim.id, 'token', null, now);
        deps.log(`claim ${claim.id} for ${d}: token found in the feed`);
      }
    }
  }

  function maybeDump(now: number): void {
    const last = Number(dir.fact('dump_at') ?? 0);
    if (now - last < DAY) return;
    try {
      mkdirSync(dirname(settings.dumpFile), { recursive: true });
      makeDump(db, settings.dumpFile, now);
      dir.setFact('dump_at', String(now));
    } catch (error) {
      deps.log(`dump: ${(error as Error).message}`);
    }
  }

  // The signer of a calendar the index publishes as its organizer: their
  // remote signer, held to the delegated kinds and to their key.
  async function openSigner(entry: StoredEntry, sessions: RemoteSession[]) {
    const connection = vault.connection(entry.d);
    if (!connection || !deps.signers || connection.owner !== entry.owner) throw new Error('no signer is connected');
    const session = limited(await deps.signers.open(connection));
    sessions.push(session);
    if (session.pubkey !== entry.owner) throw new Error('the signer signs for another key');
    return session;
  }

  async function poll(entry: StoredEntry, now: number, report: TickReport): Promise<void> {
    const planFor = (feed: NormalizedFeed): CohostPlan =>
      cohostPlan([...[...feeds.entries()].filter(([d]) => d !== entry.d).map(([, f]) => f), feed], now);
    const delegated = entry.mode === 'delegated';
    const home = delegated ? homeOf(entry) : null;
    const sessions: RemoteSession[] = [];
    let result: Awaited<ReturnType<typeof pollCalendar>>;
    try {
      result = await pollCalendar(
        { ...identityOf(entry), entryName: entry.name },
        planFor,
        {
          db,
          indexPubkey,
          now: deps.now,
          fetch: deps.fetch,
          publish: (signed) => send(signed, now, home?.relays),
          rsvps: (pubkey) => publisher.rsvps(pubkey, home?.relays),
          ...(delegated ? { signer: () => openSigner(entry, sessions) } : {}),
          keyOf,
          ...(settings.eventItems ? { itemAddress: (id: string) => (items.has(id) ? naddrFor(indexPubkey, 39999, id, [settings.publicRelay]) : null) } : {}),
          originalOf: (id) => events.originalAddressOf(id),
          ...(home ? { delegated: { relay: home.hint, claimedAt: entry.claimedAt, batch: deps.signBatch ?? SIGN_BATCH } } : {}),
        },
      );
    } finally {
      for (const session of sessions) await session.close().catch(() => {});
    }
    report.polled.push(entry.d);
    if (result.status === 'failed') {
      report.failed.push(entry.d);
      deps.log(`poll ${entry.d}: ${result.code}`);
      return;
    }
    if (result.status === 'not-modified') return;
    const { feed } = result;
    dir.setMeta(entry.d, { name: feed.calendar.name, description: feed.calendar.description, url: feed.calendar.url, image: feed.calendar.image });
    dir.setCalendarMeta(entry.d, feed.calendar);
    verifyTokens(entry.d, result.text, now);
    if (result.status === 'aggregator') return;
    feeds.set(entry.d, feed);
    events.replaceCalendar(entry.d, eventRows(feed, result.plan, now));
    report.published += result.published;
    for (const line of result.log) deps.log(`poll ${entry.d}: ${line}`);
  }

  return {
    indexPubkey,

    async tick(): Promise<TickReport> {
      const now = deps.now();
      const report: TickReport = { polled: [], failed: [], removed: [], published: 0 };

      for (const request of queues.removals('approved')) {
        const entry = dir.get(request.d);
        if (entry && !entry.removed) {
          removeCalendar(entry, now);
          report.removed.push(entry.d);
        }
        queues.resolveRemoval(request.id, 'done', now);
      }

      await carryOutClaims(now);

      const due = dir.list({ includeUnlisted: true })
        // Publishers listed from what they post are read by ingestion.
        .filter((e) => !dir.doNotIndex(e.d) && e.foundVia !== 'ingest')
        .map((e) => ({ e, at: db.pollState(e.d).nextPollAt }))
        .filter(({ at }) => at <= now)
        .sort((a, b) => a.at - b.at || (a.e.d < b.e.d ? -1 : 1))
        .slice(0, deps.maxPollsPerTick ?? 20);
      for (const { e } of due) {
        if (deps.signal?.aborted) break;
        try {
          if (e.mode === 'own') await pollOwn(e, now, report);
          else await poll(e, now, report);
        } catch (error) {
          report.failed.push(e.d);
          deps.log(`poll ${e.d}: ${(error as Error).stack ?? error}`);
        }
      }

      if (!deps.signal?.aborted) {
        try {
          await discovery.step(now);
        } catch (error) {
          deps.log(`discovery: ${(error as Error).stack ?? error}`);
        }
      }

      try {
        await ingestStep(now);
        rebuildDirty(now);
        await refreshProfiles(now);
        markCopies(now);
      } catch (error) {
        deps.log(`ingest: ${(error as Error).stack ?? error}`);
      }
      try {
        report.published += await publishDirectory(now);
      } catch (error) {
        deps.log(`directory: ${(error as Error).message}`);
      }
      try {
        await maybeBackfill(now);
      } catch (error) {
        deps.log(`outside relays: backfill: ${(error as Error).message}`);
      }
      try {
        report.published += await publishItems(now);
      } catch (error) {
        deps.log(`event items: ${(error as Error).stack ?? error}`);
      }
      maybeDump(now);
      return report;
    },
  };
}

