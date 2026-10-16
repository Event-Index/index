// Whatever link a person pastes, resolved to what the index reads: a feed
// address (for the platforms it knows, from a calendar's, group's or event's
// page) or a nostr publisher's key (an npub, an nprofile or a NIP-05
// address). Only a Luma vanity or event page, and a NIP-05 address, are read
// to resolve them, once each, through the same guarded fetch as feeds.

import { decode } from 'nostr-tools/nip19';
import type { FetchResult, Validators } from '../poller/fetch.ts';
import { checkFeedUrl } from './validate.ts';

export type Resolved =
  | { kind: 'feed'; url: string; what: 'Meetup group' | 'Luma calendar' | 'Google calendar' | 'Mobilizon group' | 'calendar feed' }
  | { kind: 'nostr'; pubkey: string; relays: string[] }
  | { kind: 'refused'; code: string; message: string };

type Fetch = (url: string, validators: Validators) => Promise<FetchResult>;

const LUMA_HOSTS = new Set(['luma.com', 'www.luma.com', 'lu.ma', 'www.lu.ma', 'api.luma.com', 'api.lu.ma']);
const MEETUP_HOSTS = new Set(['meetup.com', 'www.meetup.com']);
// First path segments on meetup.com that are not a group.
const MEETUP_PAGES = new Set(['find', 'topics', 'cities', 'apps', 'pro', 'lp', 'help', 'login', 'register', 'members', 'messages', 'notifications',
  'account', 'home', 'events', 'blog', 'about', 'media', 'terms', 'privacy', 'create', 'start', 'search', 'meetup-pro']);
// First path segments on luma.com that are not a calendar's or an event's.
const LUMA_PAGES = new Set(['discover', 'home', 'signin', 'create', 'explore', 'calendar', 'user', 'u', 'settings', 'pricing', 'event']);

const refuse = (code: string, message: string): Resolved => ({ kind: 'refused', code, message });

function feed(url: string, what: Extract<Resolved, { kind: 'feed' }>['what']): Resolved {
  const check = checkFeedUrl(url);
  if (!check.ok) {
    return check.reason === 'private-feed-url'
      ? refuse('private-feed-url', 'That address looks private: it carries a token or key. Only public calendars can be indexed.')
      : refuse(check.reason, 'That is not a link the index can use.');
  }
  return { kind: 'feed', url, what };
}

function nostrKey(text: string): Resolved | null {
  const bare = text.replace(/^nostr:/i, '');
  if (!/^(npub1|nprofile1)[02-9ac-hj-np-z]+$/i.test(bare)) return null;
  try {
    const decoded = decode(bare.toLowerCase());
    if (decoded.type === 'npub') return { kind: 'nostr', pubkey: decoded.data, relays: [] };
    if (decoded.type === 'nprofile') return { kind: 'nostr', pubkey: decoded.data.pubkey, relays: decoded.data.relays ?? [] };
  } catch {
    // Falls through to the refusal.
  }
  return refuse('invalid-key', 'That nostr key could not be read.');
}

async function nip05(name: string, domain: string, fetch: Fetch): Promise<Resolved> {
  const fetched = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, {});
  if (fetched.status === 'ok') {
    try {
      const data = JSON.parse(fetched.text) as { names?: Record<string, unknown>; relays?: Record<string, unknown> };
      const pubkey = Object.entries(data.names ?? {}).find(([n]) => n.toLowerCase() === name)?.[1];
      if (typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey)) {
        const relays = data.relays?.[pubkey];
        return { kind: 'nostr', pubkey, relays: Array.isArray(relays) ? relays.filter((r): r is string => typeof r === 'string').slice(0, 4) : [] };
      }
    } catch {
      // Falls through to the refusal.
    }
  }
  return refuse('nip05', `${name}@${domain} names no nostr key.`);
}

// The calendar a Luma page belongs to, from the page's own data.
function lumaCalendarOf(html: string): string | null {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try {
    const data = (JSON.parse(match[1]!) as { props?: { pageProps?: { initialData?: { data?: Record<string, unknown> } } } }).props?.pageProps?.initialData?.data;
    const calendar = (data?.['calendar'] as { api_id?: unknown } | undefined)?.api_id;
    const fromEvent = (data?.['event'] as { calendar_api_id?: unknown } | undefined)?.calendar_api_id;
    const id = typeof calendar === 'string' ? calendar : typeof fromEvent === 'string' ? fromEvent : null;
    return id && /^cal-[A-Za-z0-9]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const lumaFeed = (id: string) => `https://api.luma.com/ics/get?entity=calendar&id=${id}`;

export async function resolveLink(input: string, fetch: Fetch): Promise<Resolved> {
  const text = input.trim();
  const key = nostrKey(text);
  if (key) return key;
  const address = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(text);
  if (address) return nip05(address[1]!.toLowerCase(), address[2]!.toLowerCase(), fetch);

  let url: URL;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[^\s/]+\.[^\s/]+(\/|$)/.test(text) ? `https://${text}` : text;
    url = new URL(withScheme.replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return refuse('invalid-url', 'That is not a link. Paste a link to the calendar, group or event, or a nostr address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('invalid-url', 'That is not a web link.');
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (MEETUP_HOSTS.has(host)) {
    const parts = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
    const group = parts[0];
    if (!group || MEETUP_PAGES.has(group.toLowerCase()) || !/^[A-Za-z0-9_-]+$/.test(group)) {
      return refuse('meetup-page', 'That Meetup page is not a group\'s. Paste a link to the group, or to one of its events.');
    }
    return feed(`https://www.meetup.com/${group}/events/ical/`, 'Meetup group');
  }

  if (LUMA_HOSTS.has(host)) {
    if (url.pathname.replace(/\/$/, '') === '/ics/get') return feed(url.toString(), 'Luma calendar');
    if (segments[0] === 'calendar' && /^cal-[A-Za-z0-9]+$/.test(segments[1] ?? '')) return feed(lumaFeed(segments[1]!), 'Luma calendar');
    if (segments.length === 1 && /^[A-Za-z0-9_-]+$/.test(segments[0]!) && !LUMA_PAGES.has(segments[0]!.toLowerCase())) {
      const page = await fetch(`https://luma.com/${segments[0]}`, {});
      const id = page.status === 'ok' ? lumaCalendarOf(page.text) : null;
      if (id) return feed(lumaFeed(id), 'Luma calendar');
    }
    return refuse('luma-page', 'That Luma page names no calendar. Paste a link to an organizer\'s calendar, or to one of its events.');
  }

  if (host === 'calendar.google.com') {
    if (segments[0] === 'calendar' && segments[1] === 'ical') return feed(url.toString(), 'Google calendar');
    let id = url.searchParams.get('src');
    const cid = url.searchParams.get('cid');
    if (!id && cid) {
      const decoded = Buffer.from(cid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      id = /^[\w.+-]+@[\w.-]+$/.test(decoded) ? decoded : cid;
    }
    if (!id) return refuse('google-page', 'That Google Calendar link names no calendar. Use the calendar\'s public address or its embed link.');
    return feed(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`, 'Google calendar');
  }

  const group = /^\/(@[A-Za-z0-9_.-]+)(\/events)?\/?$/.exec(url.pathname);
  if (group) return feed(`https://${host}/${group[1]}/feed/ics`, 'Mobilizon group');
  if (/^\/@[A-Za-z0-9_.-]+\/feed\/ics\/?$/.test(url.pathname)) return feed(url.toString(), 'Mobilizon group');

  url.hash = '';
  return feed(url.toString(), 'calendar feed');
}
