// Facts the index learns after normalization, written into the record:
// which record a co-host's copy duplicates, where the projection lives, and
// when the calendar was claimed by its organizer.

import { naddrEncode } from 'nostr-tools/nip19';
import type { EventRecord } from '../normalize/normalize.ts';

export interface Annotation {
  canonical?: string;
  nostr?: string;
  // YYYY-MM-DD.
  claimed?: string;
}

// The claim date as the record writes it.
export function claimDate(claimedAt: number | null | undefined): string | undefined {
  return claimedAt ? new Date(claimedAt * 1000).toISOString().slice(0, 10) : undefined;
}

export function naddrFor(pubkey: string, kind: number, d: string, relays: string[]): string {
  return naddrEncode({ kind, pubkey, identifier: d, relays });
}

// Sets X-EVENTINDEX-CANONICAL, X-EVENTINDEX-NOSTR and X-EVENTINDEX-CLAIMED on
// each VEVENT by its X-EVENTINDEX-ID, replacing what an earlier poll wrote.
export function annotate(record: EventRecord, notes: Map<string, Annotation>): void {
  for (const vevent of record.component.getAllSubcomponents('vevent')) {
    const id = String(vevent.getFirstPropertyValue('x-eventindex-id') ?? '');
    const note = notes.get(id) ?? {};
    vevent.removeAllProperties('x-eventindex-canonical');
    vevent.removeAllProperties('x-eventindex-nostr');
    vevent.removeAllProperties('x-eventindex-claimed');
    if (note.canonical) vevent.addPropertyWithValue('x-eventindex-canonical', note.canonical);
    if (note.nostr) vevent.addPropertyWithValue('x-eventindex-nostr', note.nostr);
    if (note.claimed) vevent.addPropertyWithValue('x-eventindex-claimed', note.claimed);
  }
}
