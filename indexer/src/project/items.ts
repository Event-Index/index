// Event items (spec/event-items.md): one kind 39999 per real-world event of a
// mirrored calendar, signed by the index key, an item of the Events list. It
// names the event's organizer and never publishes as them. Built from the
// events table's row of an occurrence and its calendar's directory entry.

import type { EventTemplate } from './nip52.ts';
import type { EventRow } from '../store/events.ts';
import type { City } from '../service/admin.ts';
import type { Source } from '../types.ts';
import { decodeGeohash } from './geohash.ts';
import { distanceKm } from '../service/coverage.ts';
import { citySlug } from '../directory/entry.ts';
import { PLATFORMS } from './profile.ts';
import { adapterFor } from '../adapters/index.ts';

// An event that runs longer is a listing, not an event: it gets no item.
export const LONGEST_DAYS = 92;
// An item expires (NIP-40) this long after its event ends.
export const EXPIRE_AFTER = 30 * 86400;
// A venue this close to a seeded city takes the city's zone.
const ZONE_RADIUS_KM = 150;
const DAY = 86400;

export interface ItemCalendar {
  d: string;
  name: string | null;
  source: Source;
  feedUrl: string;
  // The calendar's area, `<city>, <country>`.
  location: string | null;
  // The organizer's own key, once they have verified it.
  owner: string | null;
}

export interface ItemContext {
  // The Events list's header, 39998:<key>:events.
  header: string;
  indexPubkey: string;
  calendar: ItemCalendar;
  cities: City[];
  // The event's image, from its record; carried only where its source allows.
  image: string | null;
}

export type ItemResult = { template: EventTemplate; ends: number; expires: number } | { skip: 'copy' | 'longer-than-92-days' };

// The zone an event's local time is written in: the feed's, else that of a
// seeded city near the venue, else the calendar's city's, else UTC.
export function zoneFor(tzid: string | null, g: string | null, calendarLocation: string | null, cities: City[]): string {
  if (tzid) return tzid;
  const point = g ? decodeGeohash(g) : null;
  if (point) {
    let best: { city: City; km: number } | null = null;
    for (const city of cities) {
      if (!city.timezone) continue;
      const km = distanceKm(point[0], point[1], city.latitude, city.longitude);
      if (!best || km < best.km) best = { city, km };
    }
    if (best && best.km <= ZONE_RADIUS_KM) return best.city.timezone!;
  }
  const own = cities.find((c) => `${c.name}, ${c.country}` === calendarLocation);
  return own?.timezone ?? 'UTC';
}

function parts(at: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(at * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p['weekday']} ${p['day']} ${p['month']}`, year: p['year']!, time: `${p['hour']}:${p['minute']} ${p['dayPeriod']}` };
}

// The zone's name as people know it (EDT, CEST), else its offset.
function zoneName(at: number, timeZone: string): string {
  let last = '';
  for (const locale of ['en-US', 'en-GB']) {
    last = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(new Date(at * 1000)).find((x) => x.type === 'timeZoneName')?.value ?? '';
    if (last && !/^(GMT|UTC)[+-]/.test(last)) return last;
  }
  return last || timeZone;
}

// When an event happens, written out in its local time: "Wed 28 Oct 2026,
// 5:30 PM-8:00 PM EDT"; an all-day event by its dates, its end exclusive.
export function whenText(input: { start: number; end: number | null; allDay: boolean; zone: string }): string {
  if (input.allDay) {
    const first = parts(input.start, 'UTC');
    const last = parts((input.end ?? input.start + DAY) - DAY, 'UTC');
    if (first.date === last.date && first.year === last.year) return `${first.date} ${first.year}, all day`;
    return first.year === last.year ? `${first.date} to ${last.date} ${last.year}` : `${first.date} ${first.year} to ${last.date} ${last.year}`;
  }
  const s = parts(input.start, input.zone);
  if (input.end === null) return `${s.date} ${s.year}, ${s.time} ${zoneName(input.start, input.zone)}`;
  const e = parts(input.end, input.zone);
  const zone = zoneName(input.end, input.zone);
  if (s.date === e.date && s.year === e.year) return `${s.date} ${s.year}, ${s.time}-${e.time} ${zone}`;
  return `${s.date}, ${s.time} to ${e.date} ${e.year}, ${e.time} ${zone}`;
}

const dateOf = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
const LUMA_EVENT = /^https:\/\/(?:lu\.ma|luma\.com)\/([^/?#]+)\/?$/;
const MEETUP_EVENT = /^https:\/\/www\.meetup\.com\/([^/?#]+)\/events\/([A-Za-z0-9]+)\/?/;

export function eventItem(row: EventRow, ctx: ItemContext): ItemResult {
  if (row.canonical) return { skip: 'copy' };
  const allDay = row.kind === 31922;
  const end = row.end;
  if ((end ?? row.start + (allDay ? DAY : 0)) - row.start > LONGEST_DAYS * DAY) return { skip: 'longer-than-92-days' };
  const calendar = ctx.calendar;
  const zone = zoneFor(row.tzid, row.g, calendar.location, ctx.cities);
  const source = PLATFORMS[calendar.source] ? calendar.source : new URL(calendar.feedUrl).hostname;
  const url = row.url;
  const luma = calendar.source === 'luma' && url ? LUMA_EVENT.exec(url) : null;
  const meetup = calendar.source === 'meetup' && url ? MEETUP_EVENT.exec(url) : null;
  const name = calendar.name ?? calendar.d;
  const ends = end ?? row.start;
  const expires = ends + EXPIRE_AFTER;
  const tags: Array<[string, string | null | undefined]> = [
    ['d', row.id],
    ['z', ctx.header],
    ['title', row.cancelled ? `Cancelled: ${row.title}` : row.title],
    ['start', allDay ? dateOf(row.start) : String(row.start)],
    ['end', end === null ? null : allDay ? dateOf(end) : String(end)],
    ['when', whenText({ start: row.start, end, allDay, zone })],
    ['start_tzid', allDay ? null : zone],
    ['organizer', name],
    ['calendar', `39999:${ctx.indexPubkey}:${calendar.d}`],
    ['source', source],
    ['location', row.location],
    ['g', row.g],
    ['summary', row.summary],
    ['status', row.cancelled ? 'cancelled' : null],
    ['p', calendar.owner],
    ['luma-slug', luma?.[1]],
    ['meetup-group', meetup?.[1]],
    ['meetup-event', meetup?.[2]],
    ['index-id', row.id],
    ['url', calendar.source === 'luma' || calendar.source === 'meetup' ? null : url],
    ['image', adapterFor(calendar.source).policy.images ? ctx.image : null],
    ['t', citySlug(calendar.location)],
    ['t', source],
    ['i', url],
    ['k', url ? 'web' : null],
    ['expiration', String(expires)],
    ['alt', `${name}: ${row.title}`],
  ];
  return {
    template: { kind: 39999, content: '', tags: tags.filter((t): t is [string, string] => typeof t[1] === 'string' && t[1].trim() !== '') },
    ends,
    expires,
  };
}
