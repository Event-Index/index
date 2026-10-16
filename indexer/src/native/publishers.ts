// Facts about the keys that publish NIP-52 events: which are aggregators
// (they publish other organizers' events under their own key; listed in
// seeds/nostr-aggregators.json), and which are no one's, because their
// secret is public.

import { readFileSync } from 'node:fs';
import { npubEncode } from 'nostr-tools/nip19';

// Keys whose secret is public, so anyone can sign as them: the key of secret
// 1, used in examples and tests everywhere.
export const PUBLIC_SECRET_KEYS = new Set(['79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798']);

export function loadAggregators(file: URL = new URL('../../../seeds/nostr-aggregators.json', import.meta.url)): Set<string> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { aggregators: Array<{ pubkey: string }> };
  return new Set(data.aggregators.map((a) => a.pubkey));
}

// A publisher's name when it has no profile: its key, shortened.
export function shortNpub(pubkey: string): string {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 13)}…${npub.slice(-6)}`;
}
