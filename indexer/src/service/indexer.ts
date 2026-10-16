// The poll service's work, one tick at a time: carry out approved removals,
// poll the calendars that are due, keep the events table and the directory on
// nostr up to date, and write the daily dump.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { finalizeEvent, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import type { Settings } from '../config.ts';
import type { DirectoryIdentity } from '../directory/id.ts';
import { directoryEntry, eventCalendarsHeader, eventsHeader } from '../directory/entry.ts';
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
import type { DirectoryStore, StoredEntry } from '../store/directory.ts';
import type { QueueStore } from '../store/queues.ts';
import type { EventRow, EventStore } from '../store/events.ts';
import type { Filter } from 'nostr-tools/filter';
import { setsFor, type RelaySet } from './routing.ts';

// Where an event goes: the index's own relay (always), or a set of outside
// relays (service/routing.ts).
export type Audience = 'own' | RelaySet;

export interface Publisher {
  // For `own`, resolves once the relay took the events, and a rejection fails
  // the poll so it is retried; outside sets are queued.
  publish(events: VerifiedEvent[], audience: Audience): Promise<void>;
  // Addresses of the calendar key's events that have RSVPs.
  rsvps(pubkey: string): Promise<Set<string>>;
  // What the index's own relay holds, for re-sending to outside relays.
  fetchOwn?(filter: Filter): Promise<VerifiedEvent[]>;
  // Events still queued for outside relays.
  pending?(): number;
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
const DIRECTORY_KINDS = [39998, 39999];
// Bumped when what the backfill sends changes, so it runs again.
const BACKFILL_VERSION = '1';

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
  // A relay list names only relays that hold the events.
  const generalRelays = settings.publishToGeneralRelays ? settings.generalRelays : [];

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

  // The co-host plan needs every calendar's events; until a calendar polls,
  // its stored records stand in for its feed.
  for (const entry of dir.list()) {
    const records = db.recordsOf(entry.d);
    if (records.length === 0 || entry.role !== 'calendar') continue;
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

  // When outside publishing starts, what the index's relay already holds goes
  // out once, through the same routing (no deletions); the directory's kinds
  // go once the directory goes outside. Each part is done once the queues
  // have drained; a restart before that sends it again.
  let queued: string[] = [];
  async function maybeBackfill(now: number): Promise<void> {
    if (!settings.publishToGeneralRelays || !publisher.fetchOwn) return;
    if (queued.length) {
      if ((publisher.pending?.() ?? 0) === 0) {
        for (const fact of queued) dir.setFact(fact, BACKFILL_VERSION);
        deps.log(`outside relays: backfill sent (${queued.join(', ')})`);
        queued = [];
      }
      return;
    }
    const kinds: number[] = [];
    if (dir.fact('outside_backfill') !== BACKFILL_VERSION) {
      kinds.push(...BACKFILL_KINDS);
      queued.push('outside_backfill');
    }
    if (settings.publishDirectoryOutside && dir.fact('outside_backfill_directory') !== BACKFILL_VERSION) {
      kinds.push(...DIRECTORY_KINDS);
      queued.push('outside_backfill_directory');
    }
    if (kinds.length === 0) return;
    const authors = [indexPubkey, ...allowed.live, ...allowed.removed];
    let count = 0;
    for (const author of authors) {
      const events = await publisher.fetchOwn({ authors: [author], kinds, limit: 500 });
      await sendOutside(events, { indexPubkey, now, outside: true, directory: settings.publishDirectoryOutside, backfill: true });
      count += events.length;
    }
    deps.log(`outside relays: backfill of ${count} events from ${authors.length} keys queued`);
  }

  // Signs templates (hash-tracked unless `always`) with created_at moving
  // forward per address, sends them, and records them.
  async function publishAs(
    pubkey: string,
    sign: (t: EventTemplate & { created_at: number }) => VerifiedEvent,
    items: Array<{ template: EventTemplate; d: string; start: number; always?: boolean }>,
    now: number,
  ): Promise<number> {
    const due = items
      .map((i) => ({ ...i, hash: projectionHash(i.template) }))
      .filter((i) => i.always || db.shouldPublish(pubkey, i.template.kind, i.d, i.hash));
    if (due.length === 0) return 0;
    const times = spreadCreatedAt(due.map((i) => ({ key: `${i.template.kind}:${i.d}`, last: i.always ? null : db.lastCreatedAt(pubkey, i.template.kind, i.d) })), now);
    const signed = due.map((i) => ({ i, event: sign({ ...i.template, created_at: times.get(`${i.template.kind}:${i.d}`)! }) }));
    await send(signed.map((s) => s.event), now);
    for (const { i, event } of signed) {
      if (!i.always) db.markPublished({ pubkey, kind: i.template.kind, d: i.d, hash: i.hash, eventId: event.id, createdAt: event.created_at, start: i.start, template: i.template });
    }
    return signed.length;
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
      { template: { kind: 10002, tags: [['r', settings.publicRelay], ...generalRelays.map((r) => ['r', r, 'write'])], content: '' }, d: '', start: now },
      // Follows every calendar key it holds.
      { template: { kind: 3, tags: [...allowed.live].sort().map((pk) => ['p', pk, settings.publicRelay]), content: '' }, d: '', start: now },
      { template: eventCalendarsHeader(), d: 'event-calendars', start: now },
      { template: eventsHeader(), d: 'events', start: now },
    ];
    for (const entry of dir.list({ includeRemoved: true })) {
      if (entry.role === 'calendar' && !entry.pubkey) continue;
      items.push({
        template: directoryEntry({
          identity: identityOf(entry),
          calendar: metaOf(entry, dir.calendarMeta(entry.d)),
          indexPubkey,
          pubkey: entry.pubkey,
          location: entry.location,
          geohash: entry.g,
          removed: entry.removed ?? undefined,
        }),
        d: entry.d,
        start: now,
      });
    }
    return publishAs(indexPubkey, (t) => finalizeEvent(t, deps.indexKey), items, now);
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
          await poll(e, now, report);
        } catch (error) {
          report.failed.push(e.d);
          deps.log(`poll ${e.d}: ${(error as Error).stack ?? error}`);
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

