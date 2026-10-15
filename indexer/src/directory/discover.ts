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
