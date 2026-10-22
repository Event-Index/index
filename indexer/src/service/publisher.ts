// Sends signed events to relays. The index's own relay must take every event
// (a failure fails the poll, which is retried). Every outside relay has a
// queue of its own, drained at its set's pace (service/routing.ts says which
// sets an event goes to): a small burst, then a steady rate.
//
// A relay that answers "rate-limited" or "banned" is paused for a day and
// keeps its queue; the pause is kept in the pause store, so a restart does
// not resume early. After the pause it is tried again at half its pace; a
// second such answer leaves it off until the operator resumes it. Other
// refusals are logged once per relay and message, with what each relay took.
//
// A send the relay never answers (it timed out, or the connection failed or
// closed) is not a refusal: the event goes to the back of the queue and the
// relay is waited for before its next send, 15 seconds, doubled for each
// unanswered send in a row up to 15 minutes; an answer ends the wait. An
// event unanswered on its eighth try is given up and counted refused, and a
// retry is dropped once a newer version of its address waits to be sent.

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { Settings } from '../config.ts';
import type { Audience, Publisher } from './indexer.ts';
import type { RelaySet } from './routing.ts';
import type { DirectoryStore } from '../store/directory.ts';

const OWN_CONCURRENCY = 16;
export const PACE: Record<RelaySet, { perSecond: number; burst: number }> = {
  search: { perSecond: 8, burst: 8 },
  lists: { perSecond: 2, burst: 2 },
  profiles: { perSecond: 4, burst: 4 },
  general: { perSecond: 1 / 3, burst: 3 },
};
export const PAUSE_SECONDS = 24 * 3600;
export const RETRY_WAIT = { firstMs: 15_000, maxMs: 15 * 60_000 };
export const RETRY_TRIES = 8;
const QUEUE_MAX = 50_000;
const REPORT_EVERY = 250;
// The longest a timer can wait.
const MAX_TIMER_MS = 2 ** 31 - 1;
// How long an outside relay is given to answer what it holds.
const QUERY_WAIT_MS = 20_000;

// What the publisher needs of a relay pool (nostr-tools' SimplePool).
export interface RelayPool {
  publish(relays: string[], event: VerifiedEvent): Promise<string>[];
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<unknown[]>;
  close(relays: string[]): void;
}

// A paused relay: until when (unix seconds), or left off (null).
export interface PauseState {
  until: number | null;
  strikes: number;
}

export interface PauseStore {
  get(relay: string): PauseState | null;
  set(relay: string, state: PauseState | null): void;
}

export function memoryPauses(): PauseStore {
  const states = new Map<string, PauseState>();
  return {
    get: (relay) => states.get(relay) ?? null,
    set: (relay, state) => void (state ? states.set(relay, state) : states.delete(relay)),
  };
}

const PAUSE_FACT = 'relay_pause ';

// Pauses kept in index.db, so a restart honors them and the maintainer's
// commands can list, set and clear them while the service runs.
export function relayPauses(dir: DirectoryStore): PauseStore & { all(): Array<{ relay: string; state: PauseState }> } {
  return {
    get(relay) {
      const value = dir.fact(`${PAUSE_FACT}${relay}`);
      return value ? (JSON.parse(value) as PauseState) : null;
    },
    set(relay, state) {
      if (state) dir.setFact(`${PAUSE_FACT}${relay}`, JSON.stringify(state));
      else dir.deleteFact(`${PAUSE_FACT}${relay}`);
    },
    all: () => dir.factsWithPrefix(PAUSE_FACT).map((f) => ({ relay: f.key.slice(PAUSE_FACT.length), state: JSON.parse(f.value) as PauseState })),
  };
}

export interface PublisherOptions {
  pace: Record<RelaySet, { perSecond: number; burst: number }>;
  pool: RelayPool;
  pauses: PauseStore;
  // Milliseconds, for tests.
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const LIMITED = /^(rate-limited|banned)\b|too many/i;
// nostr-tools' own reasons, when the relay gave no answer.
const UNANSWERED = /^(publish timed out|connection (failure|failed|timed out)|relay connection|websocket closed)/i;

// What a newer version replaces: the address of a replaceable or addressable
// event, else the event itself.
function addressOf(event: VerifiedEvent): string {
  const { kind } = event;
  if (kind >= 30000 && kind < 40000) return `${kind}:${event.pubkey}:${event.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`;
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return `${kind}:${event.pubkey}`;
  return event.id;
}

interface Lane {
  set: RelaySet;
  queue: VerifiedEvent[];
  draining: boolean;
  tokens: number;
  refilledAt: number;
  sent: number;
  refused: number;
  retried: number;
  // Tries of the events not yet answered, and unanswered sends in a row.
  tries: Map<string, number>;
  unanswered: number;
  messages: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export function relayPublisher(settings: Settings, log: (line: string) => void, options: Partial<PublisherOptions> = {}): Publisher {
  const pace = options.pace ?? PACE;
  const pool = options.pool ?? new SimplePool();
  const pauses = options.pauses ?? memoryPauses();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const relaysOf: Record<RelaySet, string[]> = {
    search: settings.searchRelays,
    lists: settings.listRelays,
    profiles: settings.profileRelays,
    general: settings.generalRelays,
  };
  const lanes = new Map<string, Lane>();
  let closed = false;

  const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000', '');
  const pausedNow = (relay: string): PauseState | null => {
    const state = pauses.get(relay);
    return state && (state.until === null || state.until > now() / 1000) ? state : null;
  };

  function lane(relay: string, set: RelaySet): Lane {
    let l = lanes.get(relay);
    if (!l) {
      l = { set, queue: [], draining: false, tokens: pace[set].burst, refilledAt: now(), sent: 0, refused: 0, retried: 0, tries: new Map(), unanswered: 0, messages: new Set(), timer: null };
      lanes.set(relay, l);
    }
    return l;
  }

  function report(relay: string, l: Lane): void {
    log(`${l.set} ${relay}: ${l.sent} taken, ${l.refused} refused${l.retried ? `, ${l.retried} retried` : ''}`);
  }

  // Try again when a pause ends.
  function wake(relay: string, l: Lane, until: number): void {
    if (l.timer || closed) return;
    l.timer = setTimeout(() => {
      l.timer = null;
      void drain(relay, l);
    }, Math.min(Math.max(0, until * 1000 - now()), MAX_TIMER_MS));
    l.timer.unref?.();
  }

  async function drain(relay: string, l: Lane): Promise<void> {
    if (l.draining) return;
    l.draining = true;
    let done = 0;
    while (l.queue.length > 0 && !closed) {
      const paused = pausedNow(relay);
      if (paused) {
        if (paused.until === null) l.queue.length = 0;
        else wake(relay, l, paused.until);
        break;
      }
      // Half the pace for each pause the relay has had.
      const strikes = pauses.get(relay)?.strikes ?? 0;
      const rate = pace[l.set].perSecond / 2 ** strikes;
      const t = now();
      l.tokens = Math.min(pace[l.set].burst, l.tokens + ((t - l.refilledAt) / 1000) * rate);
      l.refilledAt = t;
      if (l.tokens < 1) {
        await sleep(((1 - l.tokens) / rate) * 1000);
        continue;
      }
      l.tokens -= 1;
      const event = l.queue.shift()!;
      const [result] = await Promise.allSettled(pool.publish([relay], event));
      const message = result!.status === 'rejected' ? String((result!.reason as Error)?.message ?? result!.reason) : '';
      if (result!.status === 'rejected' && UNANSWERED.test(message)) {
        const tries = (l.tries.get(event.id) ?? 0) + 1;
        if (tries < RETRY_TRIES) {
          l.tries.set(event.id, tries);
          const address = addressOf(event);
          if (!l.queue.some((e) => addressOf(e) === address && e.created_at >= event.created_at)) {
            l.queue.push(event);
            l.retried += 1;
          } else {
            l.tries.delete(event.id);
          }
          if (!l.messages.has(message)) {
            l.messages.add(message);
            log(`${l.set} ${relay}: no answer to kind ${event.kind} (${message}); it is sent again later`);
          }
          await sleep(Math.min(RETRY_WAIT.firstMs * 2 ** l.unanswered, RETRY_WAIT.maxMs));
          l.unanswered += 1;
          continue;
        }
        l.tries.delete(event.id);
        l.refused += 1;
        log(`${l.set} ${relay}: gave up on kind ${event.kind} after ${RETRY_TRIES} tries: ${message}`);
      } else if (result!.status === 'fulfilled') {
        l.tries.delete(event.id);
        l.unanswered = 0;
        l.sent += 1;
      } else {
        l.tries.delete(event.id);
        l.unanswered = 0;
        if (LIMITED.test(message)) {
          l.queue.unshift(event);
          const strike = strikes + 1;
          if (strike >= 2) {
            pauses.set(relay, { until: null, strikes: strike });
            log(`${l.set} ${relay}: left off after a second refusal: ${message}`);
          } else {
            const until = Math.floor(now() / 1000) + PAUSE_SECONDS;
            pauses.set(relay, { until, strikes: strike });
            log(`${l.set} ${relay}: ${message}; paused until ${iso(until)}`);
          }
          continue;
        }
        l.refused += 1;
        if (!l.messages.has(message)) {
          l.messages.add(message);
          log(`${l.set} ${relay} refused kind ${event.kind}: ${message}`);
        }
      }
      done += 1;
      if (done % REPORT_EVERY === 0) report(relay, l);
    }
    if (done > 0) report(relay, l);
    l.draining = false;
  }

  return {
    async publish(events: VerifiedEvent[], audience: Audience, only?: string[]): Promise<void> {
      if (audience === 'own') {
        for (let i = 0; i < events.length; i += OWN_CONCURRENCY) {
          await Promise.all(events.slice(i, i + OWN_CONCURRENCY).map((e) => Promise.all(pool.publish([settings.relayUrl], e))));
        }
        return;
      }
      for (const relay of relaysOf[audience]) {
        if (only && !only.includes(relay)) continue;
        const l = lane(relay, audience);
        if (pausedNow(relay)?.until === null) continue;
        for (const event of events) {
          if (l.queue.length >= QUEUE_MAX) {
            log(`${audience} ${relay}: queue full, event ${event.id.slice(0, 12)} not sent`);
            continue;
          }
          l.queue.push(event);
        }
        void drain(relay, l);
      }
    },

    // An organizer's own relays: every event must be taken by one of them.
    async publishTo(events: VerifiedEvent[], relays: string[]): Promise<void> {
      for (let i = 0; i < events.length; i += OWN_CONCURRENCY) {
        await Promise.all(events.slice(i, i + OWN_CONCURRENCY).map(async (e) => {
          const results = await Promise.allSettled(pool.publish(relays, e));
          if (!results.some((r) => r.status === 'fulfilled')) {
            const reasons = results.map((r) => (r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : '')).filter(Boolean);
            throw new Error(`no relay took event ${e.id.slice(0, 12)}: ${[...new Set(reasons)].join('; ')}`);
          }
        }));
      }
    },

    async rsvps(pubkey: string, relays: string[] = []): Promise<Set<string>> {
      const found = (await pool.querySync([...new Set([settings.relayUrl, ...relays])], { kinds: [31925], '#p': [pubkey], limit: 10_000 })) as VerifiedEvent[];
      return new Set(found.flatMap((e) => e.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]!)));
    },

    // What the index's own relay holds, for re-sending.
    async fetchOwn(filter: Filter): Promise<VerifiedEvent[]> {
      return (await pool.querySync([settings.relayUrl], filter)) as VerifiedEvent[];
    },

    // What one outside relay holds. A search relay leaves out what it counts
    // as spam unless asked (NIP-50).
    async fetchFrom(relay: string, filter: Filter): Promise<VerifiedEvent[]> {
      const extra = settings.searchRelays.includes(relay) ? { search: 'include:spam' } : {};
      return (await pool.querySync([relay], { ...filter, ...extra }, { maxWait: QUERY_WAIT_MS })) as VerifiedEvent[];
    },

    // Events waiting for relays that are not paused.
    pending(): number {
      let n = 0;
      for (const [relay, l] of lanes) if (!pausedNow(relay)) n += l.queue.length + (l.draining ? 1 : 0);
      return n;
    },

    // Events waiting for one relay, paused or not.
    pendingFor(relay: string): number {
      const l = lanes.get(relay);
      return l ? l.queue.length + (l.draining ? 1 : 0) : 0;
    },

    close(): void {
      closed = true;
      let left = 0;
      for (const l of lanes.values()) {
        left += l.queue.length;
        if (l.timer) clearTimeout(l.timer);
      }
      if (left > 0) log(`${left} events left unsent to outside relays`);
      pool.close([settings.relayUrl, ...Object.values(relaysOf).flat()]);
    },
  };
}
