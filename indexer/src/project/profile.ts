// The calendar key's own events: kind 0, kind 10002, its kind 31924
// calendar, and NIP-09 deletions of its projections.

import type { ContentPolicy } from '../adapters/index.ts';
import type { Source } from '../types.ts';
import { naddrEncode, npubEncode } from 'nostr-tools/nip19';
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

// A calendar key's last profile, once the index no longer publishes with it:
// a neutral name, no NIP-05, website or picture, and the calendar's page.
export const RETIRED_NAME = 'Retired Event Index mirror';
export function retiredProfile(localName: string): EventTemplate {
  const about = `${INDEX_NAME} no longer publishes with this key. The calendar's page: ${calendarPage(localName)}`;
  return { kind: 0, tags: [], content: JSON.stringify({ name: RETIRED_NAME, about }) };
}

export interface ProfileInput {
  name: string;
  url: string | null;
  image: string | null;
  source: Source;
  localName: string;
  policy: ContentPolicy;
  // `claimed`: the organizer now publishes the calendar from their own key.
  state: 'mirrored' | 'removed' | 'claimed';
  // The organizer's key, for a claimed calendar.
  owner?: string;
}

// Where a claimed calendar now publishes.
export function claimedSentence(owner: string): string {
  return `This calendar now publishes as ${npubEncode(owner)}.`;
}

export function calendarProfile(input: ProfileInput): EventTemplate {
  const platform = PLATFORMS[input.source];
  const from = platform
    ? `mirrored from ${platform.styled} by ${INDEX_NAME}, which is not affiliated with ${platform.owner}`
    : `mirrored from its calendar feed by ${INDEX_NAME}`;
  const about = input.state === 'removed'
    ? `No longer mirrored by ${INDEX_NAME} at its organizer's request.`
    : input.state === 'claimed' && input.owner
      ? claimedSentence(input.owner)
      : `Events of ${input.name}, ${from}. Organizer? You can claim this calendar or have it removed: ${calendarPage(input.localName)}.`;
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

export interface CalendarListInput {
  name: string;
  description: string | null;
  now: number;
  items: ListedEvent[];
  // The calendar's d: `calendar` for a calendar key's one calendar; the
  // directory entry's d for one published as its organizer.
  d?: string;
  // The relay its events are on.
  relay?: string;
  // For a claimed calendar's last list: the organizer's key, their calendar
  // when they have one, and a relay of theirs.
  owner?: string;
  ownerCalendar?: string | null;
  ownerRelay?: string;
}

export function calendarList(input: CalendarListInput): EventTemplate {
  const relay = input.relay ?? INDEX_RELAY;
  const listed = input.items
    .filter((item) => item.start >= input.now - CALENDAR_LIST_PAST)
    .sort((a, b) => a.start - b.start || (a.coordinate < b.coordinate ? -1 : 1))
    .slice(0, CALENDAR_LIST_MAX);
  let content = input.description ?? '';
  if (input.owner) {
    const calendar = /^31924:([0-9a-f]{64}):(.*)$/.exec(input.ownerCalendar ?? '');
    const link = calendar
      ? naddrEncode({ kind: 31924, pubkey: calendar[1]!, identifier: calendar[2]!, relays: input.ownerRelay ? [input.ownerRelay] : [] })
      : npubEncode(input.owner);
    content = `${claimedSentence(input.owner)} nostr:${link}`;
  }
  return {
    kind: 31924,
    tags: [['d', input.d ?? 'calendar'], ['title', input.name], ...listed.map((item) => ['a', item.coordinate, relay])],
    content,
  };
}

export function deletionFor(input: { versions: string[]; coordinate: string; kind: number }): EventTemplate {
  return {
    kind: 5,
    tags: [...input.versions.map((id) => ['e', id]), ['a', input.coordinate], ['k', String(input.kind)]],
    content: '',
  };
}
