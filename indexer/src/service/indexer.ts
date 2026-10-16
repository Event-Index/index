// The poll service's work, one tick at a time: carry out approved removals,
// poll the calendars that are due, keep the events table and the directory on
// nostr up to date, and write the daily dump.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
import { calendarProfile, calendarList, deletionFor, INDEX_NAME } from '../project/profile.ts';
import { geoOf, locationsOf, summaryOf, venueHidden, type EventTemplate } from '../project/nip52.ts';
import { encodeGeohash } from '../project/geohash.ts';
import { projectionHash } from '../project/hash.ts';
import { spreadCreatedAt } from '../rules/limits.ts';
import { makeDump } from '../store/dump.ts';
import type { IndexDb } from '../store/index-db.ts';
import type { Vault } from '../store/vault-db.ts';
import { currentKey, type DirectoryStore, type StoredEntry } from '../store/directory.ts';
import type { QueueStore } from '../store/queues.ts';
import type { EventRow, EventStore } from '../store/events.ts';
import type { Filter } from 'nostr-tools/filter';
import { setsFor, type RelaySet } from './routing.ts';
import { createDiscovery } from './discovery.ts';
import { discoveredStore } from '../store/discovered.ts';
import { followed, FOLLOW_NEAR } from './follows.ts';
import { readAuthor, type RelayReader } from '../native/read.ts';
import { nativeFeed } from '../native/record.ts';
import { nextPollAt, isStale } from '../rules/schedule.ts';
import { expand } from '../project/projector.ts';

// Where an event goes: the index's own relay (always), or a set of outside
// relays (service/routing.ts).
export type Audience = 'own' | RelaySet;

export interface Publisher {
  // For `own`, resolves once the relay took the events, and a rejection fails
  // the poll so it is retried; outside sets are queued, for all of the set's
  // relays or only those named.
  publish(events: VerifiedEvent[], audience: Audience, relays?: string[]): Promise<void>;
  // Addresses of the calendar key's events that have RSVPs.
  rsvps(pubkey: string): Promise<Set<string>>;
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
  maxPollsPerTick?: number;
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
// Kinds re-sent from the index's relay when outside publishing starts, and
// the directory's, re-sent when it goes outside.
const BACKFILL_KINDS = [0, 3, 10002, 31922, 31923, 31924];
const DIRECTORY_KINDS = [39999];
// Bumped when what the backfill sends changes, so it runs again.
const BACKFILL_VERSION = '1';
// Feeds discovery checks in one tick.
const DISCOVERY_CHECKS_PER_TICK = 5;

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
  const adapter = adapterFor(feed.context.source);
  return projectable(feed, now).map((o) => {
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
      tzid: o.startTzid,
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
  });
}

export function createIndexer(deps: IndexerDeps) {
  const { db, dir, queues, events, vault, settings, publisher } = deps;
  const indexPubkey = getPublicKey(deps.indexKey);
  dir.setFact('index_pubkey', indexPubkey);
  const feeds = new Map<string, NormalizedFeed>();
  // A relay list names only relays that hold the events: the general relays
  // while outside publishing is on, and for the curator, the list relays once
  // the directory goes outside.
  const generalRelays = settings.publishToGeneralRelays ? settings.generalRelays : [];
  const listRelays = settings.publishToGeneralRelays && settings.publishDirectoryOutside ? settings.listRelays : [];

  // The keys the relay accepts events from: the index key, every calendar
  // key (named before its first events go out), and removed calendars' keys,
  // which may still publish their profile and deletions.
  const allowed = { live: new Set<string>(), removed: new Set<string>() };
  for (const entry of dir.list({ includeRemoved: true })) {
    if (entry.pubkey) (entry.removed ? allowed.removed : allowed.live).add(entry.pubkey);
  }
  function writeAllowlist(): void {
    const file = settings.relayAllowlist;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ index: indexPubkey, live: [...allowed.live].sort(), removed: [...allowed.removed].sort() })}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      deps.log(`relay allowlist: ${(error as Error).message}`);
    }
  }
  writeAllowlist();

  const discovery = createDiscovery({
    dir,
    found: discoveredStore(db),
    fetch: deps.fetch,
    log: deps.log,
    settings: { perRun: settings.discoveryPerRun, perDay: settings.discoveryPerDay, followCap: settings.followCap, checksPerStep: DISCOVERY_CHECKS_PER_TICK },
  });

  // The keys the index key follows: every key a listed entry names in `p`
  // (calendar keys, organizers' own keys, a claimed calendar's old key while
  // events it signed are to come), the earliest filed first, up to the cap.
  // Nearing or passing the cap is logged once a day.
  let followNoticeAt = -Infinity;
  function follows(now: number): string[] {
    const byKey = new Map<string, { d: string; pubkey: string; addedAt: number }>();
    const add = (d: string, pubkey: string, addedAt: number) => {
      const known = byKey.get(pubkey);
      if (!known || addedAt < known.addedAt) byKey.set(pubkey, { d, pubkey, addedAt });
    };
    for (const entry of dir.list()) {
      const key = currentKey(entry);
      if (key && entry.role === 'calendar') add(entry.d, key, entry.addedAt);
      const former = formerKeyOf(entry, now);
      if (former) add(entry.d, former, entry.addedAt);
    }
    const keys = [...byKey.values()];
    const cap = settings.followCap;
    if (keys.length >= cap * FOLLOW_NEAR && now - followNoticeAt >= DAY) {
      followNoticeAt = now;
      deps.log(keys.length > cap
        ? `follow list: ${keys.length} calendar keys, the cap is ${cap}; the ${cap} filed first are followed`
        : `follow list: ${keys.length} calendar keys, ${cap - keys.length} short of the cap of ${cap}`);
    }
    return followed(keys, cap);
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

  async function send(signed: VerifiedEvent[], now: number): Promise<void> {
    if (signed.length === 0) return;
    const fresh = signed.map((e) => e.pubkey).filter((pk) => pk !== indexPubkey && !allowed.live.has(pk) && !allowed.removed.has(pk));
    if (fresh.length) {
      for (const pk of fresh) allowed.live.add(pk);
      writeAllowlist();
    }
    await publisher.publish(signed, 'own');
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
    const authors = [indexPubkey, ...allowed.live, ...allowed.removed];
    let count = 0;
    for (const author of authors) {
      const events = await publisher.fetchOwn({ authors: [author], kinds, limit: 500 });
      const bySet = new Map<string, { set: RelaySet; relays: string[]; events: VerifiedEvent[] }>();
      for (const event of events) {
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
      count += events.length;
    }
    for (const [fact, relay] of facts) inFlight.set(fact, relay);
    deps.log(`outside relays: backfill of ${count} events from ${authors.length} keys queued for ${[...new Set(facts.map(([, r]) => r))].join(', ')}`);
  }

  // Signs templates (hash-tracked unless `always`) with created_at moving
  // forward per address, sends them, and records them.
  async function publishAs(
    pubkey: string,
    sign: (t: EventTemplate & { created_at: number }) => VerifiedEvent,
    items: Array<{ template: EventTemplate; d: string; start: number; always?: boolean }>,
    now: number,
    perSecond?: number,
  ): Promise<number> {
    const due = items
      .map((i) => ({ ...i, hash: projectionHash(i.template) }))
      .filter((i) => i.always || db.shouldPublish(pubkey, i.template.kind, i.d, i.hash));
    if (due.length === 0) return 0;
    const times = spreadCreatedAt(due.map((i) => ({ key: `${i.template.kind}:${i.d}`, last: i.always ? null : db.lastCreatedAt(pubkey, i.template.kind, i.d) })), now, perSecond);
    const signed = due.map((i) => ({ i, event: sign({ ...i.template, created_at: times.get(`${i.template.kind}:${i.d}`)! }) }));
    await send(signed.map((s) => s.event), now);
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

  // After a claim, the calendar key the index held, while events it signed
  // are still to come.
  function formerKeyOf(entry: StoredEntry, now: number): string | null {
    if (entry.mode === 'mirrored' || !entry.pubkey || entry.removed) return null;
    return db.pendingProjections(entry.pubkey, now) > 0 ? entry.pubkey : null;
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
    const read = await readAuthor(deps.reader, entry.owner, usualRelays, deps.relayAllowed ? { relayAllowed: deps.relayAllowed } : {});
    if (!read.ok) return fail('no-relay-answered');
    dir.setOwnerRelays(entry.d, read.writeRelays);
    const newestCalendar = read.calendars[0];
    const nativeCalendar = newestCalendar ? `31924:${entry.owner}:${newestCalendar.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : entry.nativeCalendar;
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
    const fresh = dir.get(entry.d)!;
    const feed = nativeFeed(read.events, {
      d: entry.d, source: 'nostr', role: 'calendar', feedUrl: '', pageUrl: fresh.pageUrl, entryName: fresh.name,
      calendarName: fresh.name, calendarAddress: `39999:${indexPubkey}:${entry.d}`,
    });
    for (const record of feed.records) {
      db.putRecord({ calendarD: entry.d, uid: record.uid, id: record.id, ics: `${ICAL.stringify(record.component.toJSON())}\r\n`, now });
    }
    events.replaceCalendar(entry.d, eventRows(feed, NO_PLAN, now));
    const nextEventStart = expand(feed, now).map((o) => o.start).filter((t) => t >= now).sort((a, b) => a - b)[0] ?? null;
    db.savePollState(entry.d, { ...state, failures: 0, firstFailureAt: null, lastSuccessAt: now, stale: false, refreshInterval: null, nextEventStart,
      nextPollAt: nextPollAt({ now, refreshInterval: null, nextEventStart, failures: 0, retryAfter: null }) });
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
      // Follows every calendar key it holds, and the organizers who publish
      // their calendars from their own keys.
      { template: { kind: 3, tags: follows(now).map((pk) => ['p', pk, settings.publicRelay]), content: '' }, d: '', start: now },
      { template: eventsHeader(), d: 'events', start: now },
    ];
    for (const entry of dir.list({ includeRemoved: true })) {
      const key = currentKey(entry);
      if (entry.role === 'calendar' && !key) continue;
      items.push({
        template: directoryEntry({
          identity: identityOf(entry),
          calendar: metaOf(entry, dir.calendarMeta(entry.d)),
          header,
          pubkey: key,
          formerKey: formerKeyOf(entry, now),
          readFrom: entry.mode === 'own' ? 'nostr' : 'feed',
          nativeCalendar: entry.nativeCalendar,
          localName: entry.localName,
          location: entry.location,
          geohash: entry.g,
          city: citySlug(entry.location),
          removed: entry.removed ?? undefined,
        }),
        d: entry.d,
        start: now,
      });
    }
    await retireOwnHeader();
    // One second each, so a list relay reads them in order.
    return publishAs(indexPubkey, (t) => finalizeEvent(t, deps.indexKey), items, now, 1);
  }

  // Returns how many events it published.
  async function removeCalendar(entry: StoredEntry, now: number): Promise<number> {
    const pubkey = entry.pubkey;
    let published = 0;
    if (pubkey) {
      const live = db.liveProjections(pubkey);
      const upcoming = live.filter((p) => (p.kind === 31922 || p.kind === 31923) && p.start >= now);
      const past = live.filter((p) => (p.kind === 31922 || p.kind === 31923) && p.start < now);
      const meta = metaOf(entry, dir.calendarMeta(entry.d));
      const items: Array<{ template: EventTemplate; d: string; start: number; always?: boolean }> = [
        ...upcoming.map((p) => ({
          template: deletionFor({ versions: db.versions(pubkey, p.kind, p.d), coordinate: `${p.kind}:${pubkey}:${p.d}`, kind: p.kind }),
          d: p.d,
          start: p.start,
          always: true,
        })),
        {
          template: calendarProfile({
            name: meta.name ?? entry.d, url: meta.url, image: meta.image, source: entry.source, localName: entry.localName,
            policy: adapterFor(entry.source).policy, state: 'removed',
          }),
          d: '',
          start: now,
        },
        {
          template: calendarList({ name: meta.name ?? entry.d, description: meta.description, now, items: past.map((p) => ({ coordinate: `${p.kind}:${pubkey}:${p.d}`, start: p.start })) }),
          d: 'calendar',
          start: now,
        },
      ];
      published = await publishAs(pubkey, (t) => vault.sign(entry.d, t), items, now);
      for (const p of upcoming) db.markWithdrawn(pubkey, p.kind, p.d, 'deleted');
      // Nothing is signed for the calendar again; its backups age out.
      vault.forget(entry.d);
      allowed.live.delete(pubkey);
      allowed.removed.add(pubkey);
      writeAllowlist();
      deps.log(`removed ${entry.d}: ${upcoming.length} upcoming events deleted, calendar key deleted`);
    }
    dir.retire(entry.d, REMOVED, now);
    events.removeCalendar(entry.d);
    feeds.delete(entry.d);
    return published;
  }

  function verifyTokens(d: string, text: string, now: number): void {
    for (const request of queues.openRemovalsFor(d)) {
      if (!request.verifiedAt && text.includes(request.token)) {
        queues.markVerified(request.id, now);
        deps.log(`remove request ${request.id} for ${d}: token found in the feed`);
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

  async function poll(entry: StoredEntry, now: number, report: TickReport): Promise<void> {
    const planFor = (feed: NormalizedFeed): CohostPlan =>
      cohostPlan([...[...feeds.entries()].filter(([d]) => d !== entry.d).map(([, f]) => f), feed], now);
    const result = await pollCalendar(
      { ...identityOf(entry), entryName: entry.name },
      planFor,
      {
        db,
        vault,
        indexPubkey,
        now: deps.now,
        fetch: deps.fetch,
        publish: (signed) => send(signed, now),
        rsvps: (pubkey) => publisher.rsvps(pubkey),
        generalRelays,
      },
    );
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
    const pubkey = vault.pubkeyFor(entry.d);
    if (pubkey) dir.setKey(entry.d, pubkey);
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
          report.published += await removeCalendar(entry, now);
          report.removed.push(entry.d);
        }
        queues.resolveRemoval(request.id, 'done', now);
      }

      const due = dir.list()
        .filter((e) => !dir.doNotIndex(e.d))
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
        report.published += await publishDirectory(now);
      } catch (error) {
        deps.log(`directory: ${(error as Error).message}`);
      }
      try {
        await maybeBackfill(now);
      } catch (error) {
        deps.log(`outside relays: backfill: ${(error as Error).message}`);
      }
      maybeDump(now);
      return report;
    },
  };
}

