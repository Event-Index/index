// Reading a native calendar by its author: the author's relay list (NIP-65)
// from the index's usual relays, then the author's NIP-52 events, profile,
// calendars and deletions from their write relays and the usual relays. The
// newest version of each address wins, and the author's own deletions are
// honored, as a relay that keeps them would.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { verifyEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { isPublicAddress } from '../directory/validate.ts';
import type { Found, NostrEvent } from './record.ts';

export interface RelayReader {
  // The events each relay holds for the filter; `answered` lists the relays
  // that answered at all.
  query(relays: string[], filter: Filter): Promise<{ found: Found[]; answered: string[] }>;
}

// How long a relay may take to answer a read, in milliseconds.
const READ_WAIT_MS = 8000;

// A reader over a nostr-tools pool: each relay is asked on its own, so one
// that does not connect is known not to have answered.
export function poolReader(pool: AbstractSimplePool, maxWait = READ_WAIT_MS): RelayReader {
  return {
    async query(relays, filter) {
      const results = await Promise.all(relays.map(async (relay) => {
        try {
          await pool.ensureRelay(relay, { connectionTimeout: maxWait });
        } catch {
          return null;
        }
        const events = await pool.querySync([relay], filter, { maxWait });
        return events.map((event) => ({ event: event as NostrEvent, relay }));
      }));
      return {
        answered: relays.filter((_, i) => results[i] !== null),
        found: results.flatMap((r) => r ?? []),
      };
    },
  };
}

export interface Profile {
  name: string | null;
  about: string | null;
  picture: string | null;
  website: string | null;
}

export interface AuthorRead {
  // At least one relay answered the read of the events.
  ok: boolean;
  // Where the author says they publish (their kind 10002), as the index
  // would connect to them.
  writeRelays: string[];
  profile: Profile | null;
  // Their kind 31924 calendars, newest first.
  calendars: NostrEvent[];
  // Their 31922 and 31923 events, the newest version of each address.
  events: Found[];
}

// The most write relays of an author the index reads from or writes to.
export const MAX_WRITE_RELAYS = 4;
// The most events read per author.
export const READ_LIMIT = 5000;

const KINDS = [0, 5, 31922, 31923, 31924];

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan|test|invalid|onion)$/i;

// Whether the index will connect to a relay someone else named: wss on a
// host that resolves only to public addresses.
export async function outsideRelay(url: string, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return isPublicAddress(host);
  if (!host.includes('.') || LOCAL_NAMES.test(host)) return false;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

const tag = (event: NostrEvent, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1];
const address = (event: NostrEvent) => `${event.kind}:${event.pubkey}:${tag(event, 'd') ?? ''}`;

// The later of two versions: newer created_at, then the lower id (NIP-01).
function later(a: Found, b: Found): Found {
  if (a.event.created_at !== b.event.created_at) return a.event.created_at > b.event.created_at ? a : b;
  return a.event.id <= b.event.id ? a : b;
}

function newest(found: Found[], kind: number): Found | null {
  return found.filter((f) => f.event.kind === kind).reduce<Found | null>((best, f) => (best ? later(best, f) : f), null);
}

// Relays the author writes to, from their newest kind 10002.
function writeRelaysOf(list: NostrEvent | null): string[] {
  if (!list) return [];
  const urls = list.tags
    .filter((t) => t[0] === 'r' && typeof t[1] === 'string' && (t[2] === undefined || t[2] === '' || t[2] === 'write'))
    .map((t) => t[1]!.trim().replace(/\/+$/, ''));
  return [...new Set(urls)];
}

function profileOf(event: NostrEvent | null): Profile | null {
  if (!event) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (key: string) => (typeof data[key] === 'string' && (data[key] as string).trim() ? (data[key] as string).trim() : null);
  return { name: text('display_name') ?? text('name'), about: text('about'), picture: text('picture'), website: text('website') };
}

export interface ReadOptions {
  // Whether an author-named relay may be used (default: outsideRelay).
  relayAllowed?: (url: string) => Promise<boolean>;
}

export async function readAuthor(reader: RelayReader, pubkey: string, usual: string[], options: ReadOptions = {}): Promise<AuthorRead> {
  const allowed = options.relayAllowed ?? ((url: string) => outsideRelay(url));
  // A plain copy, so no verification cached on the object counts.
  const genuine = (f: Found) => {
    const { id, pubkey: author, kind, created_at, tags, content, sig } = f.event;
    return author === pubkey && verifyEvent({ id, pubkey: author, kind, created_at, tags, content, sig } as Parameters<typeof verifyEvent>[0]);
  };

  const lists = await reader.query(usual, { kinds: [10002], authors: [pubkey], limit: 10 });
  const named = writeRelaysOf(newest(lists.found.filter(genuine), 10002)?.event ?? null);
  const writeRelays: string[] = [];
  for (const relay of named) {
    if (writeRelays.length >= MAX_WRITE_RELAYS) break;
    if (await allowed(relay)) writeRelays.push(relay);
  }

  const read = await reader.query([...new Set([...usual, ...writeRelays])], { kinds: KINDS, authors: [pubkey], limit: READ_LIMIT });
  const found = read.found.filter(genuine);
  const deletions = found.filter((f) => f.event.kind === 5).map((f) => f.event);
  const deletedIds = new Set(deletions.flatMap((d) => d.tags.filter((t) => t[0] === 'e').map((t) => t[1])));
  const deletedAt = new Map<string, number>();
  for (const d of deletions) {
    for (const t of d.tags) {
      if (t[0] === 'a' && t[1]?.split(':')[1] === pubkey) deletedAt.set(t[1], Math.max(deletedAt.get(t[1]) ?? 0, d.created_at));
    }
  }

  const byAddress = new Map<string, Found>();
  for (const f of found) {
    if (f.event.kind !== 31922 && f.event.kind !== 31923 && f.event.kind !== 31924) continue;
    const key = address(f.event);
    const known = byAddress.get(key);
    byAddress.set(key, known ? later(known, f) : f);
  }
  const standing = [...byAddress.values()].filter((f) => !deletedIds.has(f.event.id) && !((deletedAt.get(address(f.event)) ?? -1) >= f.event.created_at));

  return {
    ok: read.answered.length > 0,
    writeRelays,
    profile: profileOf(newest(found, 0)?.event ?? null),
    calendars: standing.filter((f) => f.event.kind === 31924).map((f) => f.event).sort((a, b) => b.created_at - a.created_at),
    events: standing.filter((f) => f.event.kind !== 31924).sort((a, b) => (address(a.event) < address(b.event) ? -1 : 1)),
  };
}
