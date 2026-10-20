// What the index signs about calendars: the kind 31924 calendar it publishes
// as an organizer, NIP-09 deletions, and the names it gives platforms.

import type { Source } from '../types.ts';
import type { EventTemplate } from './nip52.ts';

export const INDEX_NAME = 'Event Index';
export const INDEX_DOMAIN = 'eventindex.space';
export const GENERAL_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io'];
// About 160 bytes per `a` tag keeps a full list near 50 KB, under strfry's
// default 65,536-byte event size.
export const CALENDAR_LIST_MAX = 300;
export const CALENDAR_LIST_PAST = 30 * 86400;

// Each platform as its owner styles it, and the name of who owns it.
export const PLATFORMS: Partial<Record<Source, { styled: string; owner: string }>> = {
  luma: { styled: 'Luma', owner: 'Luma' },
  meetup: { styled: 'Meetup®', owner: 'Meetup' },
  mobilizon: { styled: 'Mobilizon', owner: 'Mobilizon' },
  gancio: { styled: 'Gancio', owner: 'Gancio' },
  google: { styled: 'Google Calendar', owner: 'Google' },
};

export function calendarPage(localName: string): string {
  return `https://${INDEX_DOMAIN}/calendar/${localName}`;
}

export interface ListedEvent {
  coordinate: string;
  start: number;
}

export interface CalendarListInput {
  name: string;
  description: string | null;
  now: number;
  items: ListedEvent[];
  // The calendar's d: the directory entry's.
  d: string;
  // The relay its events are on.
  relay: string;
}

export function calendarList(input: CalendarListInput): EventTemplate {
  const listed = input.items
    .filter((item) => item.start >= input.now - CALENDAR_LIST_PAST)
    .sort((a, b) => a.start - b.start || (a.coordinate < b.coordinate ? -1 : 1))
    .slice(0, CALENDAR_LIST_MAX);
  return {
    kind: 31924,
    tags: [['d', input.d], ['title', input.name], ...listed.map((item) => ['a', item.coordinate, input.relay])],
    content: input.description ?? '',
  };
}

export function deletionFor(input: { versions: string[]; coordinate: string; kind: number }): EventTemplate {
  return {
    kind: 5,
    tags: [...input.versions.map((id) => ['e', id]), ['a', input.coordinate], ['k', String(input.kind)]],
    content: '',
  };
}
