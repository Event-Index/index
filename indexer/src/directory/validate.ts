// Checks on a submitted feed: its URL must be a public address of a public
// feed, and its body must be a calendar.

import { BlockList, isIP } from 'node:net';
import type ICAL from 'ical.js';
import { parseCalendar, type NormalizedFeed } from '../normalize/normalize.ts';
import type { DirectoryIdentity } from './id.ts';
import type { Source } from '../types.ts';

export const MAX_FEED_BYTES = 5 * 1024 * 1024;

export type Check = { ok: true } | { ok: false; reason: string };

// Query parameters that carry a credential, compared lowercased without
// "-" and "_".
const SECRET_PARAMS = new Set([
  'token', 'key', 'apikey', 'accesstoken', 'auth', 'authtoken', 'secret', 'sig', 'signature', 'password', 'pass', 'pwd',
  'private', 'privatekey', 'sessionid', 'session',
]);

// Paths that are a member's or an account's private address.
const PRIVATE_PATHS: Array<[host: RegExp, path: RegExp]> = [
  [/(^|\.)meetup\.com$/, /^\/events\/ical\/\d+\/[0-9a-f]+/i],
  [/./, /\/events\/going\//],
  [/(^|\.)outlook\.(office365|office|live)\.com$/, /^\/owa\/calendar\//i],
  [/(^|\.)caldav\.icloud\.com$|^p\d+-caldav\.icloud\.com$/, /^\/published\//],
];

export function checkFeedUrl(input: string): Check {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid-url' };
  if (url.username || url.password) return { ok: false, reason: 'private-feed-url' };
  for (const name of url.searchParams.keys()) {
    if (SECRET_PARAMS.has(name.toLowerCase().replace(/[-_]/g, ''))) return { ok: false, reason: 'private-feed-url' };
  }
  let segments: string[];
  try {
    segments = url.pathname.split('/').map(decodeURIComponent);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (segments.some((s) => /^(private|secret|token)[-_]/i.test(s))) return { ok: false, reason: 'private-feed-url' };
  const host = url.hostname.toLowerCase();
  if (PRIVATE_PATHS.some(([h, p]) => h.test(host) && p.test(url.pathname))) return { ok: false, reason: 'private-feed-url' };
  return { ok: true };
}

const v4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  v4.addSubnet(network, prefix, 'ipv4');
}
const v6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['64:ff9b:1::', 48], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  v6.addSubnet(network, prefix, 'ipv6');
}

function hextets(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    text = `${text.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const fill = text.includes('::') ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(fill).fill('0'), ...right].map((h) => parseInt(h, 16));
  return all.length === 8 && all.every((n) => n >= 0 && n <= 0xffff) ? all : null;
}

function embeddedV4(words: number[]): string {
  return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.');
}

// A unicast address on the public internet. IPv4-mapped, NAT64 and 6to4
// addresses are judged by the IPv4 address inside them; IPv4-compatible
// (::/96), Teredo, local-use NAT64 and site-local addresses are not public.
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4.check(ip, 'ipv4');
  if (family !== 6) return false;
  const words = hextets(ip);
  if (!words) return false;
  const mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0);
  if (mapped || nat64) return isPublicAddress(embeddedV4(words));
  if (words.slice(0, 6).every((w) => w === 0)) return false;
  if (words[0] === 0x2002) {
    return isPublicAddress([words[1]! >> 8, words[1]! & 255, words[2]! >> 8, words[2]! & 255].join('.'));
  }
  return !v6.check(ip, 'ipv6');
}

export function validateFeed(text: string): Check {
  if (Buffer.byteLength(text, 'utf8') > MAX_FEED_BYTES) return { ok: false, reason: 'too-large' };
  let component: ICAL.Component;
  try {
    component = parseCalendar(text);
  } catch {
    return { ok: false, reason: 'not-icalendar' };
  }
  const named = ['name', 'x-wr-calname'].some((p) => String(component.getFirstPropertyValue(p) ?? '').trim());
  if (component.getAllSubcomponents('vevent').length === 0 && !named) return { ok: false, reason: 'empty' };
  return { ok: true };
}

// The platforms whose calendars the index files without review.
const KNOWN_PLATFORMS = new Set<Source>(['luma', 'meetup', 'google', 'mobilizon']);

// Safe to file without review: an organizer's own calendar on a known
// platform (a Luma calendar, a Meetup group, a public Google calendar, a
// Mobilizon group), named by its organizer rather than a platform default,
// with at least one event. The URL checks have already passed.
export function autoApprovable(identity: DirectoryIdentity, feed: NormalizedFeed): boolean {
  return KNOWN_PLATFORMS.has(identity.source) && identity.role === 'calendar' && !feed.calendar.platformDefault && feed.records.length > 0;
}
