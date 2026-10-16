// What the API serves, built from index.db: a calendar's entry with the
// index's facts about it, events in each format, and feeds of many records.
// Every event goes through the public projections, so the content policy and
// the hidden-venue rule hold in every response.

import ICAL from 'ical.js';
import { npubEncode } from 'nostr-tools/nip19';
import type { Settings } from '../../indexer/src/config.ts';
import { adapterFor } from '../../indexer/src/adapters/index.ts';
import { recordFromText, type EventRecord } from '../../indexer/src/normalize/normalize.ts';
import { naddrFor } from '../../indexer/src/project/annotate.ts';
import { publicCalendar, toJcal, toJsonLd, type PublicContext } from '../../indexer/src/project/public.ts';
import { occurrences, projectionWindow, type Occurrence } from '../../indexer/src/project/window.ts';
import type { IndexDb } from '../../indexer/src/store/index-db.ts';
import { currentKey, type DirectoryStore, type StoredEntry } from '../../indexer/src/store/directory.ts';
import type { EventRow, EventStore } from '../../indexer/src/store/events.ts';

export interface ViewDeps {
  db: IndexDb;
  dir: DirectoryStore;
  events: EventStore;
  settings: Settings;
}

const DAY = 86400;
const PRODID = '-//Event Index//eventindex.space//EN';

// How a calendar's events reach nostr: mirrored by the index with a key it
// holds, published by the organizer from their own key, or published by the
// index as the organizer, through a signer they connected.
const PUBLISHING = { mirrored: 'mirrored', own: 'organizer', delegated: 'delegated' } as const;

// A 31924 coordinate as an naddr.
function calendarAddress(coordinate: string | null, relays: string[]): string | null {
  const match = /^31924:([0-9a-f]{64}):(.*)$/.exec(coordinate ?? '');
  return match ? naddrFor(match[1]!, 31924, match[2]!, relays) : null;
}

function nostrFacts(deps: ViewDeps, entry: StoredEntry) {
  const { settings } = deps;
  if (entry.mode === 'mirrored') {
    return entry.pubkey
      ? { npub: npubEncode(entry.pubkey), nip05: `${entry.localName}@${settings.domain}`, calendar: naddrFor(entry.pubkey, 31924, 'calendar', [settings.publicRelay]) }
      : null;
  }
  if (!entry.owner) return null;
  return { npub: npubEncode(entry.owner), nip05: null, calendar: calendarAddress(entry.nativeCalendar, entry.ownerRelays.slice(0, 1)) };
}

export function calendarView(deps: ViewDeps, entry: StoredEntry) {
  const { settings } = deps;
  const state = deps.db.pollState(entry.d);
  const indexPubkey = deps.dir.fact('index_pubkey');
  const name = entry.localName;
  const fromNostr = entry.mode === 'own';
  return {
    calendar: {
      d: entry.d,
      name: entry.name,
      role: entry.role,
      source: fromNostr ? 'nostr' : entry.source,
      feed: fromNostr || !entry.feedUrl ? null : entry.feedUrl,
      url: entry.pageUrl,
      description: entry.description,
      image: adapterFor(entry.source).policy.images ? entry.image : null,
      location: entry.location,
      g: entry.g,
      t: [] as string[],
    },
    eventindex: {
      local_name: name,
      address: indexPubkey ? `39999:${indexPubkey}:${entry.d}` : null,
      nostr: nostrFacts(deps, entry),
      publishing: PUBLISHING[entry.mode],
      page: `https://${settings.domain}/calendar/${name}`,
      ics: `${settings.apiBase}/ics/calendar/${name}.ics`,
      last_indexed: state.lastSuccessAt,
      event_count: deps.events.countByCalendar(entry.d),
      stale: state.stale,
      claimed: entry.claimedAt !== null,
      claimed_at: entry.claimedAt,
      removed: entry.removed !== null,
    },
  };
}

export interface LoadedRecord {
  record: EventRecord;
  entry: StoredEntry;
  ctx: PublicContext;
  occurrences: Occurrence[];
}

// Records parsed once per response.
export type RecordCache = Map<string, LoadedRecord | null>;

export function loadRecord(deps: ViewDeps, recordId: string, now: number, cache: RecordCache = new Map()): LoadedRecord | null {
  if (cache.has(recordId)) return cache.get(recordId)!;
  const stored = deps.db.record(recordId);
  const entry = stored ? deps.dir.get(stored.calendarD) : null;
  let loaded: LoadedRecord | null = null;
  if (stored && entry) {
    const record = recordFromText(stored.ics, stored.uid, recordId);
    const meta = deps.dir.calendarMeta(entry.d) as { timezone?: string | null } | null;
    loaded = {
      record,
      entry,
      ctx: {
        calendarName: entry.name ?? entry.d,
        calendarUrl: entry.pageUrl,
        adapter: adapterFor(entry.source),
        apiBase: deps.settings.apiBase,
        changedAt: stored.changedAt,
      },
      occurrences: occurrences(record, projectionWindow(now), { calendarD: entry.d, floatingZone: meta?.timezone ?? null }).items,
    };
  }
  cache.set(recordId, loaded);
  return loaded;
}

// The nostr address an event lives at: its own, or for a co-host's copy, the
// signing calendar's; for a calendar its organizer publishes, the
// organizer's event the record came from.
function nostrOf(deps: ViewDeps, row: EventRow, event: ICAL.Component | null): string | null {
  if (deps.dir.get(row.calendarD)?.mode === 'own') {
    const naddr = event?.getFirstPropertyValue('x-eventindex-nostr');
    return typeof naddr === 'string' ? naddr : null;
  }
  const signer = row.canonical ? deps.events.byId(row.canonical) : row;
  if (!signer) return null;
  const entry = deps.dir.get(signer.calendarD);
  const pubkey = entry ? currentKey(entry) : null;
  return pubkey ? naddrFor(pubkey, signer.kind, signer.d, [deps.settings.publicRelay]) : null;
}

export function eventFacts(deps: ViewDeps, row: EventRow, entry: StoredEntry, event: ICAL.Component | null = null) {
  return {
    id: row.id,
    url: `${deps.settings.apiBase}/events/byid/${row.id}`,
    start: row.start,
    end: row.end,
    nostr: nostrOf(deps, row, event),
    calendar: row.calendarD,
    canonical: row.canonical,
    cohosts: row.cohosts,
    source: entry.source,
    via: entry.feedUrl,
  };
}

export type Format = 'jcal' | 'json';

// One item of an event list, in the format asked for; null when the record
// can no longer produce the occurrence.
export function eventItem(deps: ViewDeps, row: EventRow, format: Format, now: number, cache: RecordCache): unknown {
  const loaded = loadRecord(deps, row.recordId, now, cache);
  const occurrence = loaded?.occurrences.find((o) => o.id === row.id);
  if (!loaded || !occurrence) return null;
  if (format === 'json') return toJsonLd(occurrence, loaded.ctx);
  return { jcal: toJcal(publicCalendar(loaded.record, occurrence, loaded.ctx)), eventindex: eventFacts(deps, row, loaded.entry, occurrence.event) };
}

export function eventList(deps: ViewDeps, rows: EventRow[], format: Format, now: number) {
  const cache: RecordCache = new Map();
  const events = rows.map((row) => eventItem(deps, row, format, now, cache)).filter((item) => item !== null);
  return { events, count: events.length };
}

export type EventDocument =
  | { status: 'ok'; loaded: LoadedRecord; occurrence: Occurrence | null }
  | { status: 'not-found' }
  | { status: 'removed' };

// `/events/byid/<id>`: an occurrence the events table knows, or a record by
// its id (a recurring record as a whole, or a past event the feed dropped).
export function eventDocument(deps: ViewDeps, id: string, now: number): EventDocument {
  const row = deps.events.byId(id);
  const loaded = loadRecord(deps, row ? row.recordId : id, now);
  if (!loaded) return { status: 'not-found' };
  if (loaded.entry.removed) return { status: 'removed' };
  if (row) {
    const occurrence = loaded.occurrences.find((o) => o.id === id);
    return occurrence ? { status: 'ok', loaded, occurrence } : { status: 'not-found' };
  }
  const single = loaded.record.master && !loaded.record.master.hasProperty('rrule') && !loaded.record.master.hasProperty('rdate');
  return { status: 'ok', loaded, occurrence: single ? loaded.occurrences[0] ?? null : null };
}

const MAX_SERIES_ITEMS = 100;

export function documentJsonLd(doc: Extract<EventDocument, { status: 'ok' }>): Record<string, unknown> | null {
  const { loaded, occurrence } = doc;
  if (occurrence) return toJsonLd(occurrence, loaded.ctx);
  const items = loaded.occurrences.slice(0, MAX_SERIES_ITEMS).map((o) => toJsonLd(o, loaded.ctx));
  const first = items[0];
  if (!first) return null;
  const series: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'EventSeries',
    '@id': `${loaded.ctx.apiBase}/events/byid/${loaded.record.id}`,
    name: first['name'],
  };
  for (const key of ['url', 'organizer', 'description']) if (first[key] !== undefined) series[key] = first[key];
  series['subEvent'] = items.map(({ '@context': _, ...rest }) => rest);
  return series;
}

// Many records as one VCALENDAR, each record once, with the zones they use.
export function feedOf(deps: ViewDeps, title: string, url: string | null, rows: EventRow[], now: number): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);
  calendar.addPropertyWithValue('calscale', 'GREGORIAN');
  calendar.addPropertyWithValue('name', title);
  calendar.addPropertyWithValue('x-wr-calname', title);
  if (url) calendar.addPropertyWithValue('url', url);
  const refresh = calendar.addPropertyWithValue('refresh-interval', ICAL.Duration.fromSeconds(6 * 3600));
  refresh.setParameter('value', 'DURATION');
  const zones = new Set<string>();
  const seen = new Set<string>();
  const cache: RecordCache = new Map();
  for (const row of rows) {
    if (seen.has(row.recordId)) continue;
    seen.add(row.recordId);
    const loaded = loadRecord(deps, row.recordId, now, cache);
    if (!loaded) continue;
    const part = publicCalendar(loaded.record, null, loaded.ctx);
    for (const zone of part.getAllSubcomponents('vtimezone')) {
      const tzid = String(zone.getFirstPropertyValue('tzid'));
      if (zones.has(tzid)) continue;
      zones.add(tzid);
      calendar.addSubcomponent(zone);
    }
    for (const vevent of part.getAllSubcomponents('vevent')) calendar.addSubcomponent(vevent);
  }
  // Zones first, as most readers expect.
  const json = calendar.toJSON() as [string, unknown[], Array<[string, ...unknown[]]>];
  json[2].sort((a, b) => (a[0] === 'vtimezone' ? 0 : 1) - (b[0] === 'vtimezone' ? 0 : 1));
  return `${ICAL.stringify(json)}\r\n`;
}

// Rows in a city's feed: a co-hosted event once, from the calendar that signs it.
export function withoutCopies(rows: EventRow[]): EventRow[] {
  const ids = new Set(rows.map((r) => r.id));
  return rows.filter((r) => !(r.canonical && ids.has(r.canonical)));
}

export function feedWindow(now: number): { from: number; to: number } {
  return projectionWindow(now);
}

export function statsView(deps: ViewDeps, now: number) {
  const all = deps.dir.list({ includeRemoved: true });
  const listed = all.filter((e) => !e.removed);
  const polls = listed.map((e) => deps.db.pollState(e.d));
  const dumpAt = deps.dir.fact('dump_at');
  return {
    calendars: listed.filter((e) => e.role === 'calendar').length,
    aggregators: listed.filter((e) => e.role === 'aggregator').length,
    removed: all.length - listed.length,
    events: { upcoming: deps.events.countUpcoming(now), indexed: deps.events.count() },
    polls: {
      ok_last_24h: polls.filter((p) => p.lastSuccessAt !== null && p.lastSuccessAt >= now - DAY).length,
      failing: polls.filter((p) => p.failures > 0).length,
      stale: polls.filter((p) => p.stale).length,
    },
    dump: { url: `${deps.settings.apiBase}/dump/index.db`, generated_at: dumpAt ? Number(dumpAt) : null },
    generated_at: now,
  };
}
