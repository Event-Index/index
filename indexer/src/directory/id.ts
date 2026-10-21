// A directory entry's identity: `d` comes from a platform-stable id when the
// platform has one, so a feed URL can change without changing the calendar.

import { createHash } from 'node:crypto';
import type { Role, Source } from '../types.ts';

export interface DirectoryIdentity {
  d: string;
  source: Source;
  role: Role;
  feedUrl: string;
  pageUrl: string | null;
}

export class FeedUrlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const LUMA_HOSTS = new Set(['lu.ma', 'api.lu.ma', 'luma.com', 'api.luma.com', 'www.luma.com', 'www.lu.ma']);
const MEETUP_HOSTS = new Set(['meetup.com', 'www.meetup.com']);

function parse(input: string): URL {
  let text = input.trim();
  text = text.replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FeedUrlError('invalid-url', `not a URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FeedUrlError('invalid-url', `unsupported scheme: ${url.protocol}`);
  }
  url.hash = '';
  return url;
}

export function canonicalFeedUrl(input: string): string {
  return identify(input).feedUrl;
}

function serialize(url: URL): string {
  return url.toString().replace(/\?$/, '');
}

export function identify(input: string): DirectoryIdentity {
  const url = parse(input);
  const host = url.hostname.toLowerCase();

  if (LUMA_HOSTS.has(host) && url.pathname.replace(/\/$/, '') === '/ics/get') {
    const entity = url.searchParams.get('entity');
    const id = url.searchParams.get('id') ?? '';
    const feedUrl = `https://api.luma.com/ics/get?entity=${entity}&id=${id}`;
    if (entity === 'calendar' && /^cal-[A-Za-z0-9]+$/.test(id)) {
      return { d: `luma:${id}`, source: 'luma', role: 'calendar', feedUrl, pageUrl: `https://luma.com/calendar/${id}` };
    }
    if (entity === 'discover' && /^discplace-[A-Za-z0-9]+$/.test(id)) {
      return { d: `luma:${id}`, source: 'luma', role: 'aggregator', feedUrl, pageUrl: null };
    }
    throw new FeedUrlError('unsupported-feed', `Luma feed of entity ${entity ?? '(none)'}`);
  }

  const meetup = /^\/([A-Za-z0-9_-]+)\/events\/ical\/?$/.exec(url.pathname);
  if (MEETUP_HOSTS.has(host) && meetup) {
    const urlname = meetup[1]!;
    return {
      d: `meetup:${urlname.toLowerCase()}`,
      source: 'meetup',
      role: 'calendar',
      feedUrl: `https://www.meetup.com/${urlname}/events/ical/`,
      pageUrl: `https://www.meetup.com/${urlname}/`,
    };
  }

  const google = /^\/calendar\/ical\/([^/]+)\/public\/([a-z]+\.ics)$/.exec(url.pathname);
  if (host === 'calendar.google.com' && google) {
    let id: string;
    try {
      id = decodeURIComponent(google[1]!);
    } catch {
      throw new FeedUrlError('invalid-url', `bad percent-encoding: ${input}`);
    }
    const encoded = encodeURIComponent(id);
    return {
      d: `google:${id}`,
      source: 'google',
      role: 'calendar',
      feedUrl: `https://calendar.google.com/calendar/ical/${encoded}/public/${google[2]}`,
      pageUrl: `https://calendar.google.com/calendar/embed?src=${encoded}`,
    };
  }

  const mobilizon = /^\/@([A-Za-z0-9_.-]+)\/feed\/ics\/?$/.exec(url.pathname);
  if (mobilizon) {
    const group = mobilizon[1]!.toLowerCase();
    return {
      d: `mobilizon:${host}/@${group}`,
      source: 'mobilizon',
      role: 'calendar',
      feedUrl: `https://${host}/@${group}/feed/ics`,
      pageUrl: `https://${host}/@${group}`,
    };
  }

  // A Gancio instance's own feed, of all its events: the instance is one
  // community calendar. A feed with a query is a filtered view, not it.
  if (url.pathname.replace(/\/$/, '') === '/feed/ics' && !url.search) {
    return {
      d: `gancio:${host}`,
      source: 'gancio',
      role: 'calendar',
      feedUrl: `https://${host}/feed/ics`,
      pageUrl: `https://${host}`,
    };
  }

  const feedUrl = serialize(url);
  return {
    d: `ics:${createHash('sha256').update(feedUrl).digest('hex')}`,
    source: 'ics',
    role: 'calendar',
    feedUrl,
    pageUrl: null,
  };
}

const GOOGLE_GROUP_SUFFIX = /@group(?:\.v)?\.calendar\.google\.com$/;
const LOCAL_NAME_MAX = 64;

// A native calendar's `d`: its author's key. The index reads its events by
// that author.
export function nativeD(pubkey: string): string {
  return `nostr:${pubkey}`;
}

// A calendar's local name (its page), from its entry's `d`: lowercase,
// every run of other characters as one "-". An `ics:` entry keeps the first
// 16 hex digits of its hash, a native calendar the first 16 of its author's
// key; a name longer than 64 characters keeps its first 47 and 16 hex digits
// of the `d`'s SHA-256.
export function localName(d: string): string {
  const hashed = /^(ics|nostr):([0-9a-f]{64})$/.exec(d);
  if (hashed) return `${hashed[1]}-${hashed[2]!.slice(0, 16)}`;
  const name = d
    .replace(GOOGLE_GROUP_SUFFIX, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (name.length <= LOCAL_NAME_MAX) return name;
  return `${name.slice(0, 47).replace(/-+$/, '')}-${createHash('sha256').update(d).digest('hex').slice(0, 16)}`;
}
