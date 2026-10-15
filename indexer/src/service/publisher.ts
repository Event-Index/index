// Sends signed events to relays. The index's own relay must take every event
// (a failure fails the poll, which is retried). General relays and list-only
// relays are fed from a background queue at a bounded rate.

import { SimplePool } from 'nostr-tools/pool';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { Settings } from '../config.ts';
import type { Audience, Publisher } from './indexer.ts';

const OWN_CONCURRENCY = 16;
// Events per second to each general or list relay.
const OUTSIDE_RATE = 4;
const OUTSIDE_QUEUE_MAX = 50_000;

export function relayPublisher(settings: Settings, log: (line: string) => void): Publisher {
  const pool = new SimplePool();
  const queue: Array<{ event: VerifiedEvent; relays: string[] }> = [];
  let draining = false;
  let closed = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0 && !closed) {
      const { event, relays } = queue.shift()!;
      const results = await Promise.allSettled(pool.publish(relays, event));
      const refused = results.filter((r) => r.status === 'rejected').length;
      if (refused > 0) log(`event ${event.id.slice(0, 12)} (kind ${event.kind}): ${refused} of ${relays.length} relays refused`);
      await new Promise((r) => setTimeout(r, 1000 / OUTSIDE_RATE));
    }
    draining = false;
  }

  return {
    async publish(events: VerifiedEvent[], audience: Audience): Promise<void> {
      if (audience === 'own') {
        for (let i = 0; i < events.length; i += OWN_CONCURRENCY) {
          await Promise.all(events.slice(i, i + OWN_CONCURRENCY).map((e) => Promise.all(pool.publish([settings.relayUrl], e))));
        }
        return;
      }
      const relays = audience === 'lists' ? settings.listRelays : settings.generalRelays;
      if (relays.length === 0) return;
      for (const event of events) {
        if (queue.length >= OUTSIDE_QUEUE_MAX) {
          log(`outside queue full: event ${event.id.slice(0, 12)} not sent to ${audience} relays`);
          continue;
        }
        queue.push({ event, relays });
      }
      void drain();
    },

    async rsvps(pubkey: string): Promise<Set<string>> {
      const found = await pool.querySync([settings.relayUrl], { kinds: [31925], '#p': [pubkey], limit: 10_000 });
      return new Set(found.flatMap((e) => e.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]!)));
    },

    close(): void {
      closed = true;
      if (queue.length > 0) log(`${queue.length} events left unsent to outside relays`);
      pool.close([settings.relayUrl, ...settings.generalRelays, ...settings.listRelays]);
    },
  };
}
