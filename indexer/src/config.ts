// Settings for the indexer and the API, from the environment the deploy
// units set (deploy/templates/eventindex.env).

import { join } from 'node:path';
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

function pubkey(value: string | undefined, name: string): string | null {
  if (!value?.trim()) return null;
  if (!/^[0-9a-f]{64}$/.test(value.trim())) throw new Error(`${name}: not a hex public key: ${value}`);
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
  return {
    dataDir,
    indexDb: env['EVENTINDEX_INDEX_DB'] ?? join(dataDir, 'index.db'),
    vaultDb: env['EVENTINDEX_VAULT_DB'] ?? join(dataDir, 'vault.db'),
    dumpFile: join(dataDir, 'dump', 'index.db'),
    lockFile: join(dataDir, 'indexer.lock'),
    relayAllowlist: env['EVENTINDEX_RELAY_ALLOWLIST'] ?? join(dataDir, 'relay-allowlist.json'),
    indexKeyFile: env['EVENTINDEX_INDEX_KEY_FILE'] ?? '/etc/eventindex/index-key.nsec',
    calendarSecretFile: env['EVENTINDEX_CALENDAR_SECRET_FILE'] ?? '/etc/eventindex/calendar-key.secret',
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
    ingestNip52: env['EVENTINDEX_INGEST_NIP52'] === '1',
    ingestRelays: relays(env['EVENTINDEX_INGEST_RELAYS'], INGEST_RELAYS, 'EVENTINDEX_INGEST_RELAYS'),
    // The search relays unless set.
    ingestSearchRelays: relays(env['EVENTINDEX_INGEST_SEARCH_RELAYS'], searchRelays, 'EVENTINDEX_INGEST_SEARCH_RELAYS'),
    publishNostrEntriesOutside: env['EVENTINDEX_PUBLISH_NOSTR_ENTRIES_OUTSIDE'] === '1',
  };
}
