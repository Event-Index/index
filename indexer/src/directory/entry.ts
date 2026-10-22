// The directory on nostr: one kind 39999 entry per calendar or aggregator,
// signed by the index key as the curator of a list whose header (kind
// 39998) a maintainer signs; the entry's `z` names that header. The events
// header below is still the index key's own.

import { adapterFor, type ContentPolicy } from '../adapters/index.ts';
import type { CalendarMeta } from '../normalize/normalize.ts';
import type { EventTemplate, Tag } from '../project/nip52.ts';
import type { DirectoryIdentity } from './id.ts';

export interface EntryInput {
  identity: DirectoryIdentity;
  calendar: CalendarMeta;
  // The calendar's content policy (adapters/index.ts calendarPolicy); its
  // source's unless given.
  policy?: ContentPolicy;
  // The list header's coordinate, 39998:<pubkey>:<d>.
  header: string;
  // The organizer's own key: a publisher's, or one its organizer verified;
  // null for a calendar with none, and for an aggregator.
  pubkey: string | null;
  // `nostr` once the calendar's events are read from its organizer's own
  // key instead of its feed.
  readFrom?: 'feed' | 'nostr';
  // Its local name on the index (page and NIP-05 name).
  localName: string;
  location?: string | null;
  geohash?: string | null;
  // The city's slug, a topic.
  city?: string | null;
  // A native kind 31924 the entry stands for.
  nativeCalendar?: string | null;
  removed?: string;
}

// The slug of the city an area names ("San Diego, US" -> san-diego);
// `global` for a calendar of no one city (its area Worldwide or Online).
export function citySlug(location: string | null | undefined): string | null {
  if (location && /^(?:worldwide|online)$/i.test(location.trim())) return 'global';
  const city = location?.split(',')[0]?.trim();
  return city ? city.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null : null;
}

// The tags in the header's order, without empty values.
export function directoryEntry(input: EntryInput): EventTemplate {
  const { identity, calendar } = input;
  const policy = input.policy ?? adapterFor(identity.source).policy;
  const platformId = identity.d.slice(identity.d.indexOf(':') + 1);
  const source = input.readFrom === 'nostr' ? 'nostr' : identity.source;
  const tags: Array<[string, string | null | undefined]> = [
    ['d', identity.d],
    ['z', input.header],
    ['name', calendar.name ?? identity.d],
    ['role', identity.role],
    // An aggregator on nostr is a publisher too; a feed that only leads to
    // calendars has no key.
    ['p', identity.role === 'calendar' || identity.source === 'nostr' ? input.pubkey : null],
    ['index-name', input.localName],
    ['feed', source === 'nostr' ? null : identity.feedUrl],
    ['source', source],
    ['location', input.location],
    ['g', input.geohash],
    ['luma-id', identity.source === 'luma' && identity.role === 'calendar' ? platformId : null],
    ['meetup-group', identity.source === 'meetup' ? platformId : null],
    ['calendar', input.nativeCalendar],
    ['t', input.city],
    ['t', source],
    ['description', policy.fullDescription ? calendar.description : null],
    ['image', policy.images ? calendar.image : null],
    ['removed', input.removed],
  ];
  return { kind: 39999, tags: tags.filter((t): t is [string, string] => typeof t[1] === 'string' && t[1].trim() !== '') as Tag[], content: '' };
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
