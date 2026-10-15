// Facts the index learns after normalization, written into the record:
// which record a co-host's copy duplicates, and where the projection lives.

import { naddrEncode } from 'nostr-tools/nip19';
import type { EventRecord } from '../normalize/normalize.ts';

export interface Annotation {
  canonical?: string;
  nostr?: string;
}

export function naddrFor(pubkey: string, kind: number, d: string, relays: string[]): string {
  return naddrEncode({ kind, pubkey, identifier: d, relays });
}

// Sets X-EVENTINDEX-CANONICAL and X-EVENTINDEX-NOSTR on each VEVENT by its
// X-EVENTINDEX-ID, replacing what an earlier poll wrote.
export function annotate(record: EventRecord, notes: Map<string, Annotation>): void {
  for (const vevent of record.component.getAllSubcomponents('vevent')) {
    const id = String(vevent.getFirstPropertyValue('x-eventindex-id') ?? '');
    const note = notes.get(id) ?? {};
    vevent.removeAllProperties('x-eventindex-canonical');
    vevent.removeAllProperties('x-eventindex-nostr');
    if (note.canonical) vevent.addPropertyWithValue('x-eventindex-canonical', note.canonical);
    if (note.nostr) vevent.addPropertyWithValue('x-eventindex-nostr', note.nostr);
  }
}
