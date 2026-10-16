// What shows that a claimant runs a calendar, besides the token placed in it:
// NIP-05 at the calendar's own domain naming the claimant's key. A platform's
// domain (Luma, Meetup, Google, a Mobilizon or Gancio instance) is never a
// calendar's own.

import type { FetchResult, Validators } from '../poller/fetch.ts';
import type { StoredEntry } from '../store/directory.ts';

const PLATFORM_HOSTS = new Set(['luma.com', 'lu.ma', 'api.luma.com', 'api.lu.ma', 'meetup.com', 'calendar.google.com', 'google.com']);
// Sources whose feed is served from a shared instance, not the organizer's.
const INSTANCE_SOURCES = new Set(['mobilizon', 'gancio']);

const hostOf = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

// The domains NIP-05 may be checked at for an entry: its feed's (for a feed
// on the organizer's own site) and its page's, never a platform's.
export function calendarDomains(entry: StoredEntry, metaUrl: string | null = null): string[] {
  const instance = INSTANCE_SOURCES.has(entry.source) ? hostOf(entry.feedUrl) : null;
  const candidates = [entry.source === 'ics' ? hostOf(entry.feedUrl) : null, hostOf(entry.pageUrl), hostOf(metaUrl)];
  return [...new Set(candidates.filter((h): h is string => !!h && !PLATFORM_HOSTS.has(h) && h !== instance && h.includes('.')))];
}

// `name@domain`, or a bare domain for `_@domain`.
export function parseNip05(text: string): { name: string; domain: string } | null {
  const match = /^(?:([a-z0-9._-]+)@)?([a-z0-9.-]+\.[a-z]{2,})$/i.exec(text.trim());
  return match ? { name: (match[1] ?? '_').toLowerCase(), domain: match[2]!.toLowerCase().replace(/^www\./, '') } : null;
}

export type Nip05Check = { ok: true } | { ok: false; reason: 'nip05-invalid' | 'nip05-domain' | 'nip05-unreachable' | 'nip05-mismatch' };

export async function checkNip05(
  fetch: (url: string, validators: Validators) => Promise<FetchResult>,
  identifier: string,
  pubkey: string,
  domains: string[],
): Promise<Nip05Check> {
  const parsed = parseNip05(identifier);
  if (!parsed) return { ok: false, reason: 'nip05-invalid' };
  if (!domains.includes(parsed.domain)) return { ok: false, reason: 'nip05-domain' };
  const fetched = await fetch(`https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.name)}`, {});
  if (fetched.status !== 'ok') return { ok: false, reason: 'nip05-unreachable' };
  let names: Record<string, unknown>;
  try {
    names = ((JSON.parse(fetched.text) as { names?: Record<string, unknown> }).names) ?? {};
  } catch {
    return { ok: false, reason: 'nip05-unreachable' };
  }
  const named = Object.entries(names).find(([n]) => n.toLowerCase() === parsed.name)?.[1];
  return named === pubkey ? { ok: true } : { ok: false, reason: 'nip05-mismatch' };
}

export interface BunkerPointer {
  pubkey: string;
  relays: string[];
  secret: string | null;
}

// A remote signer's address (NIP-46): bunker://<signer key>?relay=…&secret=….
export function parseBunkerUrl(text: unknown): BunkerPointer | null {
  if (typeof text !== 'string' || text.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'bunker:' || !/^[0-9a-f]{64}$/.test(url.hostname)) return null;
  const relays = [...new Set(url.searchParams.getAll('relay').map((r) => r.trim()).filter((r) => /^wss?:\/\/[^\s]+$/i.test(r)))].slice(0, 3);
  if (relays.length === 0) return null;
  return { pubkey: url.hostname, relays, secret: url.searchParams.get('secret') || null };
}
