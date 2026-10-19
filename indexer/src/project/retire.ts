// Retiring a calendar key (spec/indexer-rules.md § 8): its last profile, then
// kind 5 deletions of everything it signed, naming each version (`e`), each
// address (`a`) and the kinds (`k`). An address and its versions are never
// split across two deletions.

import type { EventTemplate } from './nip52.ts';
import { retiredProfile } from './profile.ts';

// Tags in one deletion, so relays with an event size limit take it.
export const MAX_DELETION_TAGS = 200;

export interface SignedAddress {
  kind: number;
  d: string;
  versions: string[];
}

export function retirementTemplates(input: { pubkey: string; localName: string; addresses: SignedAddress[] }): EventTemplate[] {
  const deletions: EventTemplate[] = [];
  let chunk: SignedAddress[] = [];
  let size = 0;
  const flush = () => {
    if (!chunk.length) return;
    const kinds = [...new Set(chunk.map((a) => a.kind))].sort((a, b) => a - b);
    deletions.push({
      kind: 5,
      tags: [
        ...chunk.flatMap((a) => a.versions.map((id) => ['e', id])),
        ...chunk.map((a) => ['a', `${a.kind}:${input.pubkey}:${a.d}`]),
        ...kinds.map((k) => ['k', String(k)]),
      ],
      content: '',
    });
    chunk = [];
    size = 0;
  };
  // An address with more versions than fit is named again with each share.
  const room = MAX_DELETION_TAGS - 2;
  const shares = input.addresses.flatMap((a) => (a.versions.length <= room ? [a]
    : Array.from({ length: Math.ceil(a.versions.length / room) }, (_, n) => ({ ...a, versions: a.versions.slice(n * room, (n + 1) * room) }))));
  for (const address of shares) {
    // Its versions, its address, and room for one more kind.
    const needs = address.versions.length + 2;
    if (size + needs > MAX_DELETION_TAGS) flush();
    chunk.push(address);
    size += needs;
  }
  flush();
  return [retiredProfile(input.localName), ...deletions];
}
