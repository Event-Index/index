// Seed lists: hand-kept lists of a city's calendars on one platform, filed
// by the poll service (admin.ts import-seeds).

import type { Source } from '../types.ts';

// A seed item: a platform id, alone (found through the list's `found_via`)
// or with where it was found. `reviewed` (the date) marks a platform default
// calendar a maintainer has reviewed as an organization's: it is filed.
export type SeedItem = string | { id: string; found_via?: string; reviewed?: string };

export interface Seed {
  city: string;
  country: string;
  geonames_id: number;
  source: Source;
  found_via?: string;
  found_at: string;
  calendars: SeedItem[];
  skipped: Array<{ id: string; reason: string; found_via?: string }>;
}

const FEED_URL: Partial<Record<Source, (id: string) => string>> = {
  luma: (id) => `https://api.luma.com/ics/get?entity=calendar&id=${id}`,
  meetup: (id) => `https://www.meetup.com/${id}/events/ical/`,
};

// The feed URL of a seed list's calendar.
export function seedFeedUrl(source: Source, id: string): string {
  const build = FEED_URL[source];
  if (!build) throw new Error(`no seed feeds for source ${source}`);
  return build(id);
}
