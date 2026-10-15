// The calendar key's own events: kind 0, kind 10002, its kind 31924
// calendar, and NIP-09 deletions of its projections.

import type { ContentPolicy } from '../adapters/index.ts';
import type { Source } from '../types.ts';
import { INDEX_RELAY, type EventTemplate } from './nip52.ts';

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

export interface ProfileInput {
  name: string;
  url: string | null;
  image: string | null;
  source: Source;
  localName: string;
  policy: ContentPolicy;
  state: 'mirrored' | 'removed';
}

export function calendarProfile(input: ProfileInput): EventTemplate {
  const platform = PLATFORMS[input.source];
  const from = platform
    ? `mirrored from ${platform.styled} by ${INDEX_NAME}, which is not affiliated with ${platform.owner}`
    : `mirrored from its calendar feed by ${INDEX_NAME}`;
  const about = input.state === 'removed'
    ? `No longer mirrored by ${INDEX_NAME} at its organizer's request.`
    : `Events of ${input.name}, ${from}. Organizer? You can have this calendar removed: ${calendarPage(input.localName)}.`;
  const content: Record<string, string> = { name: input.name, about };
  if (input.image && input.policy.images) content['picture'] = input.image;
  if (input.url) content['website'] = input.url;
  content['nip05'] = `${input.localName}@${INDEX_DOMAIN}`;
  return { kind: 0, tags: [], content: JSON.stringify(content) };
}

// The index relay unmarked, so RSVPs and comments sent to the host's inbox
// reach the index; the general relays the index publishes to (none while it
// publishes only to its own), for reading.
export function relayList(general: string[] = []): EventTemplate {
  return { kind: 10002, tags: [['r', INDEX_RELAY], ...general.map((relay) => ['r', relay, 'write'])], content: '' };
}

export interface ListedEvent {
  coordinate: string;
  start: number;
}

export function calendarList(input: { name: string; description: string | null; now: number; items: ListedEvent[] }): EventTemplate {
  const listed = input.items
    .filter((item) => item.start >= input.now - CALENDAR_LIST_PAST)
    .sort((a, b) => a.start - b.start || (a.coordinate < b.coordinate ? -1 : 1))
    .slice(0, CALENDAR_LIST_MAX);
  return {
    kind: 31924,
    tags: [['d', 'calendar'], ['title', input.name], ...listed.map((item) => ['a', item.coordinate, INDEX_RELAY])],
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
