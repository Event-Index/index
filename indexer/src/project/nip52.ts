// An occurrence to a NIP-52 calendar event (kind 31923, or 31922 for an
// all-day occurrence), unsigned. The mapping is spec/nip52-mapping.md.

import ICAL from 'ical.js';
import { decode } from 'nostr-tools/nip19';
import type { Adapter, ContentPolicy } from '../adapters/index.ts';
import { adapterFor, calendarPolicy } from '../adapters/index.ts';
import type { NormalizedFeed } from '../normalize/normalize.ts';
import { summarize } from '../ical/text.ts';
import { encodeGeohash } from './geohash.ts';
import type { Occurrence } from './window.ts';

export const INDEX_RELAY = 'wss://relay.eventindex.space';
export const API_BASE = 'https://api.eventindex.space/api/1.0';
export const CLIENT = 'eventindex';
export const GEOHASH_PRECISION = 9;
export const CANCELLED_PREFIX = 'Cancelled: ';

export type Tag = string[];

export interface EventTemplate {
  kind: number;
  tags: Tag[];
  content: string;
}

export interface ProjectionContext {
  calendarName: string;
  calendarUrl: string | null;
  calendarPubkey: string;
  indexPubkey: string;
  // Keys of the other directory calendars that list the same event.
  cohosts: string[];
  adapter: Adapter;
  // The calendar's content policy: a calendar the index publishes as its
  // organizer is verified, so loosened unless kept reserved.
  policy: ContentPolicy;
  relay: string;
  apiBase: string;
  // The address of an organizer's own event an occurrence copies, by the
  // occurrence's public id.
  originalOf?: (id: string) => string | null;
}

export function projectionContext(
  feed: NormalizedFeed,
  keys: { calendarPubkey: string; indexPubkey: string; cohosts?: string[]; keptReserved?: boolean },
): ProjectionContext {
  return {
    calendarName: feed.calendar.name ?? feed.context.d,
    calendarUrl: feed.calendar.url,
    calendarPubkey: keys.calendarPubkey,
    indexPubkey: keys.indexPubkey,
    cohosts: keys.cohosts ?? [],
    adapter: adapterFor(feed.context.source),
    policy: calendarPolicy({ source: feed.context.source, owner: keys.calendarPubkey }, keys.keptReserved ?? false),
    relay: INDEX_RELAY,
    apiBase: API_BASE,
  };
}

export type ProjectionResult = { template: EventTemplate } | { skip: 'no-summary' };

function text(vevent: ICAL.Component, name: string): string | null {
  const value = vevent.getFirstPropertyValue(name);
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

export function summaryOf(vevent: ICAL.Component, adapter: Adapter): string {
  const plain = text(vevent, 'description') ?? '';
  return summarize(adapter.summaryText ? adapter.summaryText(plain) : plain);
}

const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

export function imageOf(vevent: ICAL.Component): string | null {
  const image = vevent.getFirstProperty('image');
  if (image) {
    const value = String(image.getFirstValue() ?? '').trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  for (const attach of vevent.getAllProperties('attach')) {
    if (String(attach.getParameter('encoding') ?? '').toUpperCase() === 'BASE64') continue;
    const value = String(attach.getFirstValue() ?? '').trim();
    if (!/^https?:\/\//i.test(value)) continue;
    const type = String(attach.getParameter('fmttype') ?? '').toLowerCase();
    if (type.startsWith('image/') || (!type && IMAGE_URL.test(value))) return value;
  }
  return null;
}

export function locationsOf(vevent: ICAL.Component): string[] {
  const values = [
    ...vevent.getAllProperties('location').map((p) => String(p.getFirstValue() ?? '').trim()),
    ...vevent.getAllSubcomponents('vlocation').map((v) => String(v.getFirstPropertyValue('name') ?? '').trim()),
  ];
  return [...new Set(values.filter(Boolean))];
}

export function geoOf(vevent: ICAL.Component): [number, number] | null {
  const value = vevent.getFirstPropertyValue('geo');
  if (!Array.isArray(value) || value.length < 2) return null;
  const lat = Number(value[0]);
  const lon = Number(value[1]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return [lat, lon];
}

export function venueHidden(vevent: ICAL.Component): boolean {
  return text(vevent, 'x-eventindex-venue') === 'hidden';
}

function categoriesOf(vevent: ICAL.Component): string[] {
  const values = vevent
    .getAllProperties('categories')
    .flatMap((p) => p.getValues())
    .map((v) => String(v).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}

function participantsOf(vevent: ICAL.Component): Tag[] {
  const tags: Tag[] = [];
  for (const participant of vevent.getAllSubcomponents('participant')) {
    const address = String(participant.getFirstPropertyValue('calendar-address') ?? '').trim();
    const match = /^nostr:(npub1[02-9ac-hj-np-z]+|nprofile1[02-9ac-hj-np-z]+)$/i.exec(address);
    if (!match) continue;
    let pubkey: string;
    let relay = '';
    try {
      const decoded = decode(match[1]!.toLowerCase());
      if (decoded.type === 'npub') pubkey = decoded.data;
      else if (decoded.type === 'nprofile') {
        pubkey = decoded.data.pubkey;
        relay = decoded.data.relays?.[0] ?? '';
      } else continue;
    } catch {
      continue;
    }
    const role = String(participant.getFirstPropertyValue('participant-type') ?? 'participant').trim().toLowerCase();
    tags.push(['p', pubkey, relay, role || 'participant']);
  }
  return tags;
}

const DAY = 86400;

// At most this many D tags, so a mistyped end year cannot make an event
// larger than a relay accepts.
export const MAX_DAY_TAGS = 400;

// 31923 only: one D per UTC day the event touches.
function dayTags(o: Occurrence): Tag[] {
  const first = Math.floor(o.start / DAY);
  const reach = o.end !== null && o.end > o.start ? Math.floor((o.end - 1) / DAY) : first;
  const last = Math.min(reach, first + MAX_DAY_TAGS - 1);
  const tags: Tag[] = [];
  for (let day = first; day <= last; day += 1) tags.push(['D', String(day)]);
  return tags;
}

// The start date, YYYY-MM-DD, in the start zone (UTC when there is none).
function localDate(unix: number, tzid: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tzid ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(unix * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function recordUrl(apiBase: string, id: string): string {
  return `${apiBase}/events/byid/${id}.ics`;
}

export function projectOccurrence(o: Occurrence, ctx: ProjectionContext): ProjectionResult {
  const vevent = o.event;
  const summaryProperty = text(vevent, 'summary');
  if (!summaryProperty) return { skip: 'no-summary' };
  const title = o.cancelled ? `${CANCELLED_PREFIX}${summaryProperty}` : summaryProperty;
  const summary = summaryOf(vevent, ctx.adapter);
  const tags: Tag[] = [['d', o.d], ['title', title]];
  if (summary) tags.push(['summary', summary]);
  const image = ctx.policy.images ? imageOf(vevent) : null;
  if (image) tags.push(['image', image]);

  if (o.allDay) {
    tags.push(['start', o.startDate!]);
    if (o.endDate && o.endDate > o.startDate!) tags.push(['end', o.endDate]);
  } else {
    tags.push(['start', String(o.start)]);
    const hasEnd = o.end !== null && o.end > o.start;
    if (hasEnd) tags.push(['end', String(o.end)]);
    if (o.startTzid) tags.push(['start_tzid', o.startTzid]);
    if (hasEnd && o.endTzid && o.endTzid !== o.startTzid) tags.push(['end_tzid', o.endTzid]);
    tags.push(...dayTags(o));
  }

  // A hidden venue has no place in any projection.
  if (!venueHidden(vevent)) {
    for (const location of locationsOf(vevent)) tags.push(['location', location]);
    const geo = geoOf(vevent);
    if (geo) tags.push(['g', encodeGeohash(geo[0], geo[1], GEOHASH_PRECISION)]);
  }

  tags.push(['p', ctx.calendarPubkey, ctx.relay, 'host']);
  for (const cohost of ctx.cohosts) tags.push(['p', cohost, ctx.relay, 'host']);
  tags.push(...participantsOf(vevent));
  for (const category of categoriesOf(vevent)) tags.push(['t', category]);

  const page = text(vevent, 'url') ?? ctx.calendarUrl;
  if (page) tags.push(['r', page]);
  tags.push(['r', recordUrl(ctx.apiBase, o.id)]);
  // A copy names the organizer's own event it yields to.
  const original = ctx.originalOf?.(o.id);
  if (original) tags.push(['q', original, '']);
  tags.push(['z', `39998:${ctx.indexPubkey}:events`]);
  const when = o.allDay ? o.startDate! : localDate(o.start, o.startTzid);
  tags.push(['alt', `${ctx.calendarName}: ${title}, ${when}`]);
  tags.push(['client', CLIENT]);

  return { template: { kind: o.allDay ? 31922 : 31923, tags, content: summary } };
}
