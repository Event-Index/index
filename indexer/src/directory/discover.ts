// Discovery: an aggregator leads the index to organizer calendars.

export interface DiscoveredCalendar {
  id: string;
  name: string;
  slug: string | null;
  personal: boolean;
}

// The calendars a Luma city page's events belong to, read from the page's
// own data (`__NEXT_DATA__`).
export function lumaCalendarsFromPage(html: string): DiscoveredCalendar[] {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return [];
  }
  const found = new Map<string, DiscoveredCalendar>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const o = value as Record<string, unknown>;
    const id = o['api_id'];
    if (typeof id === 'string' && /^cal-[A-Za-z0-9]+$/.test(id) && typeof o['name'] === 'string' && (o['access_level'] ?? 'public') === 'public') {
      if (!found.has(id)) {
        found.set(id, {
          id,
          name: o['name'],
          slug: typeof o['slug'] === 'string' ? o['slug'] : null,
          personal: o['is_personal'] === true,
        });
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(data);
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface PageCalendar {
  id: string;
  name: string;
  slug: string | null;
  // An account's own calendar (Luma's "Personal"): a platform default.
  personal: boolean;
  // Luma's access level; only `public` calendars are taken.
  access: string;
}

export interface PageEvent {
  calendar: PageCalendar;
  name: string | null;
  url: string | null;
  start: string | null;
  hosts: string[];
}

export interface CityPage {
  place: { id: string; slug: string; name: string } | null;
  events: PageEvent[];
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// What a Luma city page shows, from its own data: its place, and each event
// with the calendar it belongs to and its hosts.
export function lumaCityPage(html: string): CityPage {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return { place: null, events: [] };
  let data: { props?: { pageProps?: { initialData?: { data?: { place?: Record<string, unknown>; events?: unknown } } } } };
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return { place: null, events: [] };
  }
  const page = data.props?.pageProps?.initialData?.data;
  const p = page?.place;
  const place = p && text(p['api_id'])?.startsWith('discplace-') ? { id: text(p['api_id'])!, slug: text(p['slug']) ?? '', name: text(p['name']) ?? '' } : null;
  const events: PageEvent[] = [];
  for (const item of Array.isArray(page?.events) ? page.events as Array<Record<string, unknown>> : []) {
    const c = (item['calendar'] ?? {}) as Record<string, unknown>;
    const e = (item['event'] ?? {}) as Record<string, unknown>;
    const id = text(c['api_id']);
    if (!id || !/^cal-[A-Za-z0-9]+$/.test(id)) continue;
    const path = text(e['url']);
    events.push({
      calendar: {
        id,
        name: text(c['name']) ?? '',
        slug: text(c['slug']),
        personal: c['is_personal'] === true || typeof c['personal_user_api_id'] === 'string',
        access: text(c['access_level']) ?? 'public',
      },
      name: text(e['name']),
      url: path ? `https://luma.com/${path}` : null,
      start: text(e['start_at']) ?? text(item['start_at']),
      hosts: (Array.isArray(item['hosts']) ? item['hosts'] as Array<Record<string, unknown>> : []).map((h) => text(h['name'])).filter((n): n is string => !!n),
    });
  }
  return { place, events };
}

export interface Skipped {
  id: string;
  reason: 'platform-default-calendar';
}

// Automated seeding files calendars an organizer created and named. A
// platform account's default calendar (Luma's "Personal") is skipped; it
// enters only when its owner submits or claims it.
export function seedable(calendars: DiscoveredCalendar[]): { seed: DiscoveredCalendar[]; skipped: Skipped[] } {
  const seed: DiscoveredCalendar[] = [];
  const skipped: Skipped[] = [];
  for (const calendar of calendars) {
    if (calendar.personal || calendar.name.trim() === 'Personal') skipped.push({ id: calendar.id, reason: 'platform-default-calendar' });
    else seed.push(calendar);
  }
  return { seed, skipped };
}
