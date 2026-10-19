// Settings for the indexer and the API, from the environment the deploy
// units set (deploy/templates/eventindex.env).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERAL_RELAYS } from './project/profile.ts';
import { FOLLOW_CAP } from './service/follows.ts';

export interface Settings {
  dataDir: string;
  indexDb: string;
  vaultDb: string;
  dumpFile: string;
  lockFile: string;
  // The keys the relay's write policy accepts (relay/src/policy.ts).
  relayAllowlist: string;
  indexKeyFile: string;
  calendarSecretFile: string;
  // Seals signer connections and derives the intake key (spec/indexer-rules.md § 8).
  signerSecretFile: string;
  // The index's own relay, as the services reach it, and as the world does.
  relayUrl: string;
  publicRelay: string;
  apiPort: number;
  apiBase: string;
  domain: string;
  // Off unless set: publish beyond the index's own relay, to the four sets
  // below (service/routing.ts says what goes where).
  publishToGeneralRelays: boolean;
  generalRelays: string[];
  // Relays that take only list kinds; they get the directory and headers.
  listRelays: string[];
  // Off unless set: the directory's entries (kind 39999) go outside too.
  publishDirectoryOutside: boolean;
  // The coordinate of the list header the entries belong to (39998:<key>:<d>),
  // signed by a maintainer; null for one under the index key.
  directoryHeader: string | null;
  // Relays that index events for search.
  searchRelays: string[];
  // Relays that keep profiles and relay lists.
  profileRelays: string[];
  // Discovery's caps (service/discovery.ts): new calendars a page's run may
  // take, and calendars it files in a day.
  discoveryPerRun: number;
  discoveryPerDay: number;
  // The most calendar keys the index key follows (service/follows.ts).
  followCap: number;
  // The publisher whose upcoming events the coverage report compares with
  // the index's (hex), and the relay it reads them from; none unless set.
  coveragePubkey: string | null;
  coverageRelay: string | null;
  // Off unless set: the index's relay also takes the events of organizers
  // the index publishes as (kinds 31922, 31923, 31924 and 5).
  hostClaimants: boolean;
  // Off unless set: no calendar key is made, and nothing a calendar key signs
  // goes to outside relays (or is sent again to them), until it is turned off.
  // Calendars are still read and served; keys are never deleted meanwhile.
  calendarKeysPaused: boolean;
  // Off unless set: the index key publishes an item of the Events list per
  // upcoming event of each mirrored calendar (spec/event-items.md), and the
  // directory names no calendar key. `eventsHeader` is that list's header,
  // 39998:<maintainer's key>:events.
  eventItems: boolean;
  eventsHeader: string | null;
  // At most this many event items live at once; null for no cap.
  eventItemsMax: number | null;
  // Only these calendars' events are items, when set (a file listing their
  // d, such as seeds/item-calendars.json); null for every mirrored calendar.
  eventItemsCalendars: Set<string> | null;
  // Off unless set: read every public NIP-52 event by kind (native/ingest.ts)
  // from these relays, and from these search relays with their include:spam
  // extension, and list each publisher in the directory.
  ingestNip52: boolean;
  ingestRelays: string[];
  ingestSearchRelays: string[];
  // Off unless set: the directory entries of publishers listed that way go
  // to the list and search relays too; until then they stay on the index's.
  publishNostrEntriesOutside: boolean;
}

export const INGEST_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.formstr.app'];

export const PROFILE_RELAYS = ['wss://purplepag.es'];

// A comma-separated list; empty for the default, `none` for no relays.
function relays(value: string | undefined, fallback: string[], name: string): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim() === 'none') return [];
  const list = value.split(',').map((r) => r.trim()).filter(Boolean);
  for (const r of list) if (!/^wss?:\/\//.test(r)) throw new Error(`${name}: not a relay URL: ${r}`);
  return list;
}

function count(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name}: not a whole number: ${value}`);
  return Number(value.trim());
}

// A JSON file, { "calendars": [<d> | { "d": <d>, ... }, ...] }; a relative
// path is the repository's.
function calendarList(path: string | undefined, name: string): Set<string> | null {
  if (!path?.trim()) return null;
  const file = resolve(fileURLToPath(new URL('../../', import.meta.url)), path.trim());
  let list: unknown;
  try {
    list = (JSON.parse(readFileSync(file, 'utf8')) as { calendars?: unknown }).calendars;
  } catch (error) {
    throw new Error(`${name}: cannot read ${file}: ${(error as Error).message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${name}: ${file} has no list of calendars`);
  return new Set(list.map((c: unknown) => {
    const d = typeof c === 'string' ? c : (c as { d?: unknown } | null)?.d;
    if (typeof d !== 'string' || !d.trim()) throw new Error(`${name}: ${file}: not a calendar: ${JSON.stringify(c)}`);
    return d.trim();
  }));
}

function pubkey(value: string | undefined, name: string): string | null {
  if (!value?.trim()) return null;
  if (!/^[0-9a-f]{64}$/.test(value.trim())) throw new Error(`${name}: not a hex public key: ${value}`);
  return value.trim();
}

function eventsHeader(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  if (!/^39998:[0-9a-f]{64}:events$/.test(value.trim())) throw new Error(`EVENTINDEX_EVENTS_HEADER: not the Events list's header coordinate: ${value}`);
  return value.trim();
}

function header(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  if (!/^39998:[0-9a-f]{64}:.+$/.test(value.trim())) throw new Error(`EVENTINDEX_DIRECTORY_HEADER: not a list header coordinate: ${value}`);
  return value.trim();
}

export function loadSettings(env: Record<string, string | undefined>): Settings {
  const dataDir = env['EVENTINDEX_DATA_DIR'] ?? '/var/lib/eventindex';
  const relayUrl = env['EVENTINDEX_RELAY_URL'] ?? 'ws://127.0.0.1:7777';
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error(`EVENTINDEX_RELAY_URL: not a relay URL: ${relayUrl}`);
  const searchRelays = relays(env['EVENTINDEX_SEARCH_RELAYS'], [], 'EVENTINDEX_SEARCH_RELAYS');
  if (env['EVENTINDEX_EVENT_ITEMS'] === '1' && !eventsHeader(env['EVENTINDEX_EVENTS_HEADER'])) {
    throw new Error('EVENTINDEX_EVENTS_HEADER: event items need the Events list\'s header, 39998:<key>:events');
  }
  return {
    dataDir,
    indexDb: env['EVENTINDEX_INDEX_DB'] ?? join(dataDir, 'index.db'),
    vaultDb: env['EVENTINDEX_VAULT_DB'] ?? join(dataDir, 'vault.db'),
    dumpFile: join(dataDir, 'dump', 'index.db'),
    lockFile: join(dataDir, 'indexer.lock'),
    relayAllowlist: env['EVENTINDEX_RELAY_ALLOWLIST'] ?? join(dataDir, 'relay-allowlist.json'),
    indexKeyFile: env['EVENTINDEX_INDEX_KEY_FILE'] ?? '/etc/eventindex/index-key.nsec',
    calendarSecretFile: env['EVENTINDEX_CALENDAR_SECRET_FILE'] ?? '/etc/eventindex/calendar-key.secret',
    signerSecretFile: env['EVENTINDEX_SIGNER_SECRET_FILE'] ?? '/etc/eventindex/signer.secret',
    relayUrl,
    publicRelay: env['EVENTINDEX_PUBLIC_RELAY'] ?? 'wss://relay.eventindex.space',
    apiPort: Number(env['EVENTINDEX_API_PORT'] ?? 8080),
    apiBase: env['EVENTINDEX_API_BASE'] ?? 'https://api.eventindex.space/api/1.0',
    domain: env['EVENTINDEX_DOMAIN'] ?? 'eventindex.space',
    publishToGeneralRelays: env['EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS'] === '1',
    generalRelays: relays(env['EVENTINDEX_GENERAL_RELAYS'], GENERAL_RELAYS, 'EVENTINDEX_GENERAL_RELAYS'),
    listRelays: relays(env['EVENTINDEX_LIST_RELAYS'], [], 'EVENTINDEX_LIST_RELAYS'),
    publishDirectoryOutside: env['EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE'] === '1',
    directoryHeader: header(env['EVENTINDEX_DIRECTORY_HEADER']),
    searchRelays,
    profileRelays: relays(env['EVENTINDEX_PROFILE_RELAYS'], PROFILE_RELAYS, 'EVENTINDEX_PROFILE_RELAYS'),
    discoveryPerRun: count(env['EVENTINDEX_DISCOVERY_PER_RUN'], 25, 'EVENTINDEX_DISCOVERY_PER_RUN'),
    discoveryPerDay: count(env['EVENTINDEX_DISCOVERY_PER_DAY'], 300, 'EVENTINDEX_DISCOVERY_PER_DAY'),
    followCap: count(env['EVENTINDEX_FOLLOW_CAP'], FOLLOW_CAP, 'EVENTINDEX_FOLLOW_CAP'),
    coveragePubkey: pubkey(env['EVENTINDEX_COVERAGE_PUBKEY'], 'EVENTINDEX_COVERAGE_PUBKEY'),
    coverageRelay: relays(env['EVENTINDEX_COVERAGE_RELAY'], [], 'EVENTINDEX_COVERAGE_RELAY')[0] ?? null,
    hostClaimants: env['EVENTINDEX_RELAY_HOSTS_CLAIMANTS'] === '1',
    calendarKeysPaused: env['EVENTINDEX_CALENDAR_KEYS_PAUSED'] === '1',
    eventItems: env['EVENTINDEX_EVENT_ITEMS'] === '1',
    eventsHeader: eventsHeader(env['EVENTINDEX_EVENTS_HEADER']),
    eventItemsMax: env['EVENTINDEX_EVENT_ITEMS_MAX']?.trim() ? count(env['EVENTINDEX_EVENT_ITEMS_MAX'], 0, 'EVENTINDEX_EVENT_ITEMS_MAX') : null,
    eventItemsCalendars: calendarList(env['EVENTINDEX_EVENT_ITEMS_CALENDARS'], 'EVENTINDEX_EVENT_ITEMS_CALENDARS'),
    ingestNip52: env['EVENTINDEX_INGEST_NOSTR'] === '1',
    ingestRelays: relays(env['EVENTINDEX_INGEST_RELAYS'], INGEST_RELAYS, 'EVENTINDEX_INGEST_RELAYS'),
    // The search relays unless set.
    ingestSearchRelays: relays(env['EVENTINDEX_INGEST_SEARCH_RELAYS'], searchRelays, 'EVENTINDEX_INGEST_SEARCH_RELAYS'),
    publishNostrEntriesOutside: env['EVENTINDEX_PUBLISH_NOSTR_ENTRIES_OUTSIDE'] === '1',
  };
}
