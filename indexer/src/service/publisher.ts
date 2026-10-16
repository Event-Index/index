// Sends signed events to relays. The index's own relay must take every event
// (a failure fails the poll, which is retried). Each set of outside relays
// (service/routing.ts) has a queue of its own, drained at its own rate, so a
// slow set never holds up another. A relay that answers "rate-limited" gets
// the event again later, more slowly; every other refusal is logged once per
// relay and message, with a count of what each relay took and refused.

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { Settings } from '../config.ts';
import type { Audience, Publisher } from './indexer.ts';
import type { RelaySet } from './routing.ts';

const OWN_CONCURRENCY = 16;
// Events per second to each set (each event goes to all relays of its set).
export const RATES: Record<RelaySet, number> = { search: 8, lists: 2, profiles: 4, general: 2 };
const QUEUE_MAX = 50_000;
const MAX_DELAY_MS = 10_000;
const RETRIES = 3;
const REPORT_EVERY = 250;

// What the publisher needs of a relay pool (nostr-tools' SimplePool).
export interface RelayPool {
  publish(relays: string[], event: VerifiedEvent): Promise<string>[];
  querySync(relays: string[], filter: Filter): Promise<unknown[]>;
  close(relays: string[]): void;
}

interface Tally {
  sent: number;
  refused: number;
  messages: Set<string>;
}

export function relayPublisher(
  settings: Settings,
  log: (line: string) => void,
  rates: Record<RelaySet, number> = RATES,
  pool: RelayPool = new SimplePool(),
): Publisher {
  const relaysOf: Record<RelaySet, string[]> = {
    search: settings.searchRelays,
    lists: settings.listRelays,
    profiles: settings.profileRelays,
    general: settings.generalRelays,
  };
  // An item goes to every relay of its set, or after a rate limit, to the
  // relays that asked to wait.
  const queues = new Map<RelaySet, Array<{ event: VerifiedEvent; tries: number; relays?: string[] }>>();
  const draining = new Set<RelaySet>();
  const tallies = new Map<string, Tally>();
  let closed = false;

  const tally = (relay: string) => {
    let t = tallies.get(relay);
    if (!t) tallies.set(relay, (t = { sent: 0, refused: 0, messages: new Set() }));
    return t;
  };
  const report = (set: RelaySet) => {
    for (const relay of relaysOf[set]) {
      const t = tally(relay);
      log(`${set} ${relay}: ${t.sent} taken, ${t.refused} refused`);
    }
  };

  async function drain(set: RelaySet): Promise<void> {
    if (draining.has(set)) return;
    draining.add(set);
    const queue = queues.get(set)!;
    const base = 1000 / rates[set];
    let delay = base;
    let done = 0;
    while (queue.length > 0 && !closed) {
      const item = queue.shift()!;
      const relays = item.relays ?? relaysOf[set];
      const results = await Promise.allSettled(pool.publish(relays, item.event));
      const limited: string[] = [];
      results.forEach((result, i) => {
        const t = tally(relays[i]!);
        if (result.status === 'fulfilled') {
          t.sent += 1;
          return;
        }
        const message = String((result.reason as Error)?.message ?? result.reason);
        if (/^rate-limited/i.test(message) && item.tries < RETRIES) {
          limited.push(relays[i]!);
          return;
        }
        t.refused += 1;
        if (!t.messages.has(message)) {
          t.messages.add(message);
          log(`${set} ${relays[i]} refused kind ${item.event.kind}: ${message}`);
        }
      });
      if (limited.length) {
        queue.push({ event: item.event, tries: item.tries + 1, relays: limited });
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      } else {
        delay = Math.max(base, delay / 1.5);
      }
      done += 1;
      if (done % REPORT_EVERY === 0) report(set);
      await new Promise((r) => setTimeout(r, delay));
    }
    if (done > 0) report(set);
    draining.delete(set);
  }

  return {
    async publish(events: VerifiedEvent[], audience: Audience): Promise<void> {
      if (audience === 'own') {
        for (let i = 0; i < events.length; i += OWN_CONCURRENCY) {
          await Promise.all(events.slice(i, i + OWN_CONCURRENCY).map((e) => Promise.all(pool.publish([settings.relayUrl], e))));
        }
        return;
      }
      if (relaysOf[audience].length === 0) return;
      if (!queues.has(audience)) queues.set(audience, []);
      const queue = queues.get(audience)!;
      for (const event of events) {
        if (queue.length >= QUEUE_MAX) {
          log(`${audience} queue full: event ${event.id.slice(0, 12)} not sent`);
          continue;
        }
        queue.push({ event, tries: 0 });
      }
      void drain(audience);
    },

    async rsvps(pubkey: string): Promise<Set<string>> {
      const found = (await pool.querySync([settings.relayUrl], { kinds: [31925], '#p': [pubkey], limit: 10_000 })) as VerifiedEvent[];
      return new Set(found.flatMap((e) => e.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]!)));
    },

    // What the index's own relay holds, for re-sending.
    async fetchOwn(filter: Filter): Promise<VerifiedEvent[]> {
      return (await pool.querySync([settings.relayUrl], filter)) as VerifiedEvent[];
    },

    pending(): number {
      let n = 0;
      for (const [set, queue] of queues) n += queue.length + (draining.has(set) ? 1 : 0);
      return n;
    },

    close(): void {
      closed = true;
      const left = [...queues.values()].reduce((n, q) => n + q.length, 0);
      if (left > 0) log(`${left} events left unsent to outside relays`);
      pool.close([settings.relayUrl, ...Object.values(relaysOf).flat()]);
    },
  };
}
