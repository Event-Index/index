// Settings for the indexer and the API, from the environment the deploy
// units set (deploy/templates/eventindex.env).

import { join } from 'node:path';
import { GENERAL_RELAYS } from './project/profile.ts';

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
  // Relays that index events for search.
  searchRelays: string[];
  // Relays that keep profiles and relay lists.
  profileRelays: string[];
}

export const PROFILE_RELAYS = ['wss://purplepag.es'];

// A comma-separated list; empty for the default, `none` for no relays.
function relays(value: string | undefined, fallback: string[], name: string): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim() === 'none') return [];
  const list = value.split(',').map((r) => r.trim()).filter(Boolean);
  for (const r of list) if (!/^wss?:\/\//.test(r)) throw new Error(`${name}: not a relay URL: ${r}`);
  return list;
}

export function loadSettings(env: Record<string, string | undefined>): Settings {
  const dataDir = env['EVENTINDEX_DATA_DIR'] ?? '/var/lib/eventindex';
  const relayUrl = env['EVENTINDEX_RELAY_URL'] ?? 'ws://127.0.0.1:7777';
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error(`EVENTINDEX_RELAY_URL: not a relay URL: ${relayUrl}`);
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
    searchRelays: relays(env['EVENTINDEX_SEARCH_RELAYS'], [], 'EVENTINDEX_SEARCH_RELAYS'),
    profileRelays: relays(env['EVENTINDEX_PROFILE_RELAYS'], PROFILE_RELAYS, 'EVENTINDEX_PROFILE_RELAYS'),
  };
}
