// The directory on nostr: one kind 39999 entry per calendar or aggregator,
// on the Event Calendars list, and the two list headers the index key
// publishes. The wire format is the Event Index protocol draft's §§ 2 and 3.

import { adapterFor } from '../adapters/index.ts';
import type { CalendarMeta } from '../normalize/normalize.ts';
import type { EventTemplate, Tag } from '../project/nip52.ts';
import type { DirectoryIdentity } from './id.ts';

export interface EntryInput {
  identity: DirectoryIdentity;
  calendar: CalendarMeta;
  indexPubkey: string;
  // The calendar key; null for an aggregator.
  pubkey: string | null;
  location?: string | null;
  geohash?: string | null;
  topics?: string[];
  removed?: string;
}

export function directoryEntry(input: EntryInput): EventTemplate {
  const { identity, calendar } = input;
  const tags: Tag[] = [
    ['d', identity.d],
    ['z', `39998:${input.indexPubkey}:event-calendars`],
    ['name', calendar.name ?? identity.d],
    ['role', identity.role],
  ];
  if (identity.role === 'calendar' && input.pubkey) tags.push(['p', input.pubkey]);
  tags.push(['feed', identity.feedUrl]);
  const page = calendar.url ?? identity.pageUrl;
  if (page) tags.push(['url', page]);
  tags.push(['source', identity.source]);
  if (input.location) tags.push(['location', input.location]);
  if (input.geohash) tags.push(['g', input.geohash]);
  for (const topic of input.topics ?? []) tags.push(['t', topic]);
  if (calendar.description) tags.push(['description', calendar.description]);
  if (calendar.image && adapterFor(identity.source).policy.images) tags.push(['image', calendar.image]);
  if (input.removed) tags.push(['removed', input.removed]);
  return { kind: 39999, tags, content: '' };
}

export function eventCalendarsHeader(): EventTemplate {
  return {
    kind: 39998,
    content: '',
    tags: [
      ['d', 'event-calendars'],
      ['names', 'Event Calendar', 'Event Calendars'],
      ['description', 'Public event calendars. A calendar\'s events are mirrored to nostr as NIP-52 events signed by a key of its own.'],
      ['required', 'name', 'The calendar\'s name as its organizer gives it (RFC 7986 NAME, else X-WR-CALNAME unless it is a platform default such as Luma\'s Personal, else the organizer\'s name)'],
      ['required', 'role', 'calendar | aggregator. A calendar\'s events are signed by its own key. An aggregator only leads to calendars.'],
      ['recommended', 'p', 'The calendar\'s own nostr key (held by the index until claimed). Absent on aggregators.'],
      ['recommended', 'feed', 'iCalendar feed URL the entry is indexed from'],
      ['recommended', 'url', 'The calendar\'s page on its platform (RFC 7986 URL)'],
      ['recommended', 'source', 'luma | meetup | mobilizon | gancio | google | ics | nostr'],
      ['allowed', 'organizer', 'Organizer\'s name when the feed states one'],
      ['allowed', 'location', 'City or region, as text'],
      ['allowed', 'g', 'Geohash of the calendar\'s usual area'],
      ['allowed', 'calendar', 'A native kind-31924 calendar this entry stands for'],
      ['allowed', 't', 'Topic tags'],
      ['allowed', 'description', 'RFC 7986 DESCRIPTION'],
      ['allowed', 'image', 'RFC 7986 IMAGE'],
      ['field-type', 'feed', 'url'],
      ['field-type', 'url', 'url'],
      ['field-type', 'image', 'url'],
      ['field-type', 'calendar', 'address'],
      ['display', 'title', 'name'],
      ['display', 'summary', 'organizer'],
      ['display', 'image', 'image'],
      ['display', 'link', 'url'],
      ['display', 'location', 'g'],
      ['display', 'fact', 'role', 'Type'],
      ['display', 'fact', 'location', 'Area'],
    ],
  };
}

export function eventsHeader(): EventTemplate {
  return {
    kind: 39998,
    content: '',
    tags: [
      ['d', 'events'],
      ['names', 'Event', 'Events'],
      ['description', 'Calendar events mirrored from the calendars on Event Calendars. Items are NIP-52 events that carry a z to this header.'],
      ['item-kind', '31923', 'Time-based calendar event (NIP-52)'],
      ['item-kind', '31922', 'Date-based calendar event (NIP-52)'],
      ['required', 'title', ''],
      ['required', 'start', 'Start, unix seconds (31923) or YYYY-MM-DD (31922)'],
      ['recommended', 'end', ''],
      ['recommended', 'location', 'Address, room or link, as the organizer wrote it'],
      ['recommended', 'summary', ''],
      ['allowed', 'image', ''],
      ['allowed', 'g', 'Geohash'],
      ['allowed', 'r', 'The event\'s page at its source first, then its full record on the index'],
      ['allowed', 't', ''],
      ['field-type', 'start', 'date'],
      ['field-type', 'end', 'date'],
      ['field-type', 'image', 'url'],
      ['field-type', 'r', 'url'],
      ['display', 'title', 'title'],
      ['display', 'summary', 'summary'],
      ['display', 'image', 'image'],
      ['display', 'link', 'r'],
      ['display', 'location', 'g'],
      ['display', 'date', 'start'],
    ],
  };
}
