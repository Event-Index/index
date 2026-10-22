import type { Source } from '../types.ts';
import type { Adapter } from './types.ts';
import { luma } from './luma.ts';
import { meetup } from './meetup.ts';
import { mobilizon } from './mobilizon.ts';
import { gancio } from './gancio.ts';
import { google } from './google.ts';
import { generic } from './generic.ts';

export type { Adapter, ContentPolicy, CalendarSide } from './types.ts';
import type { ContentPolicy } from './types.ts';

const adapters: Partial<Record<Source, Adapter>> = { luma, meetup, mobilizon, gancio, google };

export function adapterFor(source: Source): Adapter {
  return adapters[source] ?? generic(source);
}

// A calendar's content policy (spec/platform-adapters.md, Content policy): its
// source's, as summary and link, until its organizer verifies with Event
// Index (a link, B1 or B2, which names their key as its owner); then its full
// description, and images where its source allows them. Kept reserved, or
// without a verified organizer, it is its source's again.
export function calendarPolicy(calendar: { source: Source; owner: string | null }, keptReserved = false): ContentPolicy {
  const adapter = adapterFor(calendar.source);
  if (!calendar.owner || keptReserved) return adapter.policy;
  return { fullDescription: true, images: adapter.imagesOnceVerified ?? true };
}
