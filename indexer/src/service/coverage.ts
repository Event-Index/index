// The coverage report: of another publisher's upcoming NIP-52 events in the
// index's cities, how many the index already holds. An event is held when
// one of the index's events starts within 15 minutes of it, in the same city,
// and their titles or their venues match once normalized. The other
// publisher's events are only read for the comparison, never stored or
// republished.

import { decodeGeohash } from '../project/geohash.ts';
import type { EventRow } from '../store/events.ts';
import type { City } from './admin.ts';

export const MATCH_WINDOW = 15 * 60;
// How far from a city's centre its events are.
export const CITY_RADIUS_KM = 50;
// Coordinates this close are one venue.
const VENUE_KM = 0.3;

export interface Reference {
  id: string;
  title: string;
  start: number;
  tzid: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  link: string | null;
}

export interface CityCoverage {
  city: City;
  total: number;
  held: number;
  misses: Reference[];
}

export interface CoverageReport {
  total: number;
  cities: CityCoverage[];
  // References farther than the radius from every city, and with no place.
  elsewhere: number;
  unplaced: number;
}

const tag = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1]?.trim() || null;

export function referenceOf(event: { id: string; kind: number; tags: string[][]; content: string }): Reference | null {
  const title = tag(event.tags, 'title') ?? tag(event.tags, 'name');
  const start = tag(event.tags, 'start');
  if (!title || !start) return null;
  const at = /^\d+$/.test(start) ? Number(start) : Date.parse(`${start}T00:00:00Z`) / 1000;
  if (!Number.isFinite(at)) return null;
  const g = tag(event.tags, 'g');
  const point = g ? decodeGeohash(g) : null;
  return {
    id: event.id, title, start: at, tzid: tag(event.tags, 'start_tzid'), location: tag(event.tags, 'location'),
    lat: point?.[0] ?? null, lon: point?.[1] ?? null, link: tag(event.tags, 'r'),
  };
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const words = (text: string) => new Set(normalize(text).split(' ').filter((w) => w.length > 1));

export function titlesMatch(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.includes(' ') && ` ${long} `.includes(` ${short} `)) return true;
  const [wa, wb] = [words(a), words(b)];
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared >= 2 && shared / new Set([...wa, ...wb]).size >= 0.5;
}

// A venue's name: its location up to the first comma or bracket.
const venueName = (location: string | null) => normalize(location?.split(/[,(]/)[0] ?? '');

export function venuesMatch(ref: Reference, row: EventRow): boolean {
  const point = row.g ? decodeGeohash(row.g) : null;
  if (ref.lat !== null && ref.lon !== null && point && distanceKm(ref.lat, ref.lon, point[0], point[1]) <= VENUE_KM) return true;
  const [a, b] = [venueName(ref.location), venueName(row.location)];
  if (a.length < 4 || b.length < 4) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function cityOf(ref: Reference, cities: City[]): City | null {
  if (ref.lat === null || ref.lon === null) return null;
  let best: { city: City; km: number } | null = null;
  for (const city of cities) {
    const km = distanceKm(ref.lat, ref.lon, city.latitude, city.longitude);
    if (km <= CITY_RADIUS_KM && (!best || km < best.km)) best = { city, km };
  }
  return best?.city ?? null;
}

// `near` gives the index's events that start in a span; `areaOf` a calendar's
// area, for an event that carries no coordinates; `ignore` the index's events
// that do not count, such as the publisher's own, which the index also reads.
export function coverage(
  refs: Reference[],
  cities: City[],
  near: (from: number, to: number) => EventRow[],
  areaOf: (calendarD: string) => [number, number] | null,
  options: { ignore?: (row: EventRow) => boolean } = {},
): CoverageReport {
  const report: CoverageReport = { total: refs.length, cities: [], elsewhere: 0, unplaced: 0 };
  const byCity = new Map<string, CityCoverage>();
  for (const ref of refs) {
    if (ref.lat === null || ref.lon === null) {
      report.unplaced += 1;
      continue;
    }
    const city = cityOf(ref, cities);
    if (!city) {
      report.elsewhere += 1;
      continue;
    }
    const entry = byCity.get(city.slug) ?? { city, total: 0, held: 0, misses: [] };
    byCity.set(city.slug, entry);
    entry.total += 1;
    const held = near(ref.start - MATCH_WINDOW, ref.start + MATCH_WINDOW).some((row) => {
      if (Math.abs(row.start - ref.start) > MATCH_WINDOW || options.ignore?.(row)) return false;
      const point = (row.g ? decodeGeohash(row.g) : null) ?? areaOf(row.calendarD);
      if (point && distanceKm(point[0], point[1], ref.lat!, ref.lon!) > CITY_RADIUS_KM) return false;
      return titlesMatch(ref.title, row.title) || venuesMatch(ref, row);
    });
    if (held) entry.held += 1;
    else entry.misses.push(ref);
  }
  report.cities = [...byCity.values()].sort((a, b) => b.total - a.total || a.city.name.localeCompare(b.city.name));
  return report;
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '-');

function when(ref: Reference, zone: string | undefined): string {
  const timeZone = ref.tzid ?? zone ?? 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(ref.start * 1000)).replace(',', '');
  } catch {
    return new Date(ref.start * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function formatCoverage(report: CoverageReport, about: { source: string; relay: string; now: number }): string[] {
  const inCities = report.cities.reduce((n, c) => n + c.total, 0);
  const held = report.cities.reduce((n, c) => n + c.held, 0);
  const lines = [
    `coverage ${new Date(about.now * 1000).toISOString().slice(0, 10)}: ${about.source} on ${about.relay}`,
    `${held} of ${inCities} upcoming events in the index's cities (${percent(held, inCities)}); ${report.elsewhere} elsewhere, ${report.unplaced} without a place`,
  ];
  const width = Math.max(0, ...report.cities.map((c) => c.city.name.length));
  for (const c of report.cities) lines.push(`${c.city.name.padEnd(width)}  ${`${c.held} of ${c.total}`.padStart(9)}  ${percent(c.held, c.total).padStart(4)}`);
  for (const c of report.cities) {
    if (c.misses.length === 0) continue;
    lines.push('', `${c.city.name}: not in the index`);
    for (const m of [...c.misses].sort((a, b) => a.start - b.start)) {
      lines.push(`  ${when(m, c.city.timezone)}  ${[m.title, m.location, m.link].filter(Boolean).join(' — ')}`);
    }
  }
  return lines;
}

export interface NostrEventLike {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

const PAGE = 5000;
const MAX_PAGES = 50;

// A publisher's upcoming events, read from a relay page by page (each page
// up to the oldest it held, until a page brings nothing new), the newest
// version of each.
export async function upcomingReferences(
  query: (filter: { kinds: number[]; authors: string[]; limit: number; until?: number }) => Promise<NostrEventLike[]>,
  pubkey: string,
  now: number,
): Promise<Reference[]> {
  const seen = new Set<string>();
  const newest = new Map<string, NostrEventLike>();
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await query({ kinds: [31922, 31923], authors: [pubkey], limit: PAGE, ...(until === undefined ? {} : { until }) });
    const fresh = batch.filter((e) => !seen.has(e.id));
    if (fresh.length === 0) break;
    for (const e of fresh) {
      seen.add(e.id);
      const key = `${e.kind}:${tag(e.tags, 'd') ?? e.id}`;
      const held = newest.get(key);
      if (!held || held.created_at < e.created_at) newest.set(key, e);
    }
    until = batch.reduce((min, e) => Math.min(min, e.created_at), Infinity);
  }
  return [...newest.values()].map(referenceOf).filter((r): r is Reference => !!r && r.start >= now);
}
