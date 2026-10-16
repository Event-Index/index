// What the home page shows from the directory: four weeks of days with their
// event counts, a few upcoming events across cities, and the cities.

import type { Cities } from '../../indexer/src/service/admin.ts';
import type { StoredEntry } from '../../indexer/src/store/directory.ts';
import type { EventRow } from '../../indexer/src/store/events.ts';

const DAY = 86400;
const WEEKS = 4;

export interface Start {
  start: number;
  tzid: string | null;
  allDay: boolean;
}

export interface GridDay {
  date: string;
  count: number;
  past: boolean;
  today: boolean;
}

function dateIn(unix: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unix * 1000));
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 10);
  }
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);

// Four weeks from the Monday of this week. An event counts on its own local
// date; today is the earliest current date among the zones the events use,
// so no city's today is in the past.
export function dayGrid(starts: Start[], now: number): { days: GridDay[] } {
  const zones = new Set(['UTC', ...starts.map((s) => s.tzid).filter((z): z is string => !!z)]);
  const today = [...zones].map((z) => dateIn(now, z)).sort()[0]!;
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const first = addDays(today, -weekday);
  const counts = new Map<string, number>();
  for (const s of starts) {
    const date = s.allDay ? new Date(s.start * 1000).toISOString().slice(0, 10) : dateIn(s.start, s.tzid ?? 'UTC');
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const date = addDays(first, i);
    return { date, count: counts.get(date) ?? 0, past: date < today, today: date === today };
  });
  return { days };
}

// The ring's size for a day's event count, in four steps of the busiest
// day's count, so the grid shows which days are busier at any scale.
export function ringFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((4 * count) / max)));
}

const cityOf = (entry: StoredEntry) => entry.location?.split(',')[0]?.trim() || null;

export interface Upcoming {
  row: EventRow;
  calendar: StoredEntry;
  city: string | null;
}

// The soonest upcoming events, taken from each city in turn so one city
// does not fill the list; a co-host's copy and cancelled events are left out.
export function comingUp(rows: EventRow[], entries: StoredEntry[], now: number, n: number): Upcoming[] {
  const byD = new Map(entries.filter((e) => !e.removed).map((e) => [e.d, e]));
  const queues = new Map<string, Upcoming[]>();
  for (const row of [...rows].sort((a, b) => a.start - b.start)) {
    const calendar = byD.get(row.calendarD);
    if (!calendar || row.start < now || row.cancelled || row.canonical) continue;
    const city = cityOf(calendar);
    const key = city ?? '';
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push({ row, calendar, city });
  }
  const picked: Upcoming[] = [];
  const lists = [...queues.values()];
  for (let round = 0; picked.length < n && lists.some((l) => l.length > round); round += 1) {
    for (const list of lists) {
      if (picked.length < n && list[round]) picked.push(list[round]!);
    }
  }
  return picked.sort((a, b) => a.row.start - b.row.start);
}

export interface CityCount {
  name: string;
  slug: string;
  count: number;
}

export const slugify = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function cityCounts(entries: StoredEntry[], cities: Cities): CityCount[] {
  const counts = new Map<string, CityCount>();
  for (const entry of entries) {
    if (entry.removed || entry.role !== 'calendar' || !entry.location) continue;
    const known = cities.cities.find((c) => `${c.name}, ${c.country}` === entry.location);
    const name = known?.name ?? cityOf(entry)!;
    const slug = known?.slug ?? slugify(name);
    const city = counts.get(slug) ?? { name, slug, count: 0 };
    city.count += 1;
    counts.set(slug, city);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// The zone to show a calendar's times in when an event carries none: its
// city's.
export function cityZones(entries: StoredEntry[], cities: Cities): Map<string, string> {
  const zones = new Map<string, string>();
  for (const entry of entries) {
    const zone = cities.cities.find((c) => `${c.name}, ${c.country}` === entry.location)?.timezone;
    if (zone) zones.set(entry.d, zone);
  }
  return zones;
}
