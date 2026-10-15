// Seed lists to directory entries. Each listed calendar's feed is fetched and
// validated; a platform's default calendar is skipped unless asked for; the
// entries come out unsigned, with created_at spread, for the index key to
// sign.

import { identify } from './id.ts';
import { checkFeedUrl, validateFeed } from './validate.ts';
import { directoryEntry } from './entry.ts';
import { normalizeFeed } from '../normalize/normalize.ts';
import { spreadCreatedAt, MAX_PER_SECOND } from '../rules/limits.ts';
import type { EventTemplate } from '../project/nip52.ts';
import type { FetchResult } from '../poller/fetch.ts';
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

export interface SeedDeps {
  fetch: (url: string) => Promise<FetchResult>;
  indexPubkey: string;
  now: number;
  // The calendar key of an entry (created on first use).
  keyFor: (d: string) => string;
  perSecond?: number;
  // File default calendars too (an owner's own submission).
  includeDefaultCalendars?: boolean;
}

export type SeedOutcome =
  | { id: string; outcome: 'filed' }
  | { id: string; outcome: 'skipped' | 'refused'; reason: string };

const FEED_URL: Partial<Record<Source, (id: string) => string>> = {
  luma: (id) => `https://api.luma.com/ics/get?entity=calendar&id=${id}`,
  meetup: (id) => `https://www.meetup.com/${id}/events/ical/`,
};

export async function seedEntries(seed: Seed, deps: SeedDeps): Promise<{ entries: Array<EventTemplate & { created_at: number }>; report: SeedOutcome[] }> {
  const build = FEED_URL[seed.source];
  if (!build) throw new Error(`no seed feeds for source ${seed.source}`);
  const report: SeedOutcome[] = [];
  const entries = new Map<string, EventTemplate>();
  for (const item of seed.calendars) {
    const id = typeof item === 'string' ? item : item.id;
    const reviewed = typeof item !== 'string' && !!item.reviewed;
    const url = build(id);
    const check = checkFeedUrl(url);
    if (!check.ok) {
      report.push({ id, outcome: 'refused', reason: check.reason });
      continue;
    }
    const identity = identify(url);
    if (entries.has(identity.d)) continue;
    const fetched = await deps.fetch(identity.feedUrl);
    if (fetched.status !== 'ok') {
      report.push({ id, outcome: 'refused', reason: fetched.status === 'error' ? fetched.code : 'not-modified' });
      continue;
    }
    const valid = validateFeed(fetched.text);
    if (!valid.ok) {
      report.push({ id, outcome: 'refused', reason: valid.reason });
      continue;
    }
    const feed = normalizeFeed(fetched.text, identity);
    if (feed.calendar.platformDefault && !deps.includeDefaultCalendars && !reviewed) {
      report.push({ id, outcome: 'skipped', reason: 'platform-default-calendar' });
      continue;
    }
    entries.set(identity.d, directoryEntry({
      identity,
      calendar: feed.calendar,
      indexPubkey: deps.indexPubkey,
      pubkey: identity.role === 'calendar' ? deps.keyFor(identity.d) : null,
      location: `${seed.city}, ${seed.country}`,
    }));
    report.push({ id, outcome: 'filed' });
  }
  const times = spreadCreatedAt([...entries.keys()].map((key) => ({ key, last: null })), deps.now, deps.perSecond ?? MAX_PER_SECOND);
  return { entries: [...entries.entries()].map(([d, e]) => ({ ...e, created_at: times.get(d)! })), report };
}
