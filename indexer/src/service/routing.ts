// Which relays beyond the index's own receive an event. Four sets, each a
// list of relays in the settings:
//   search    relays that index events for search: everything the index
//             projects, in the window
//   lists     relays that take only list kinds: the directory
//   profiles  profile relays: profiles, relay lists, the follow list
//   general   general relays: profiles, relay lists, the follow list,
//             calendars, and upcoming events only
// The index key's profile and relay list always go to the profile and
// general relays, so a change to them never stays on the index's relay alone.

import { WINDOW_PAST } from '../project/window.ts';

export type RelaySet = 'search' | 'lists' | 'profiles' | 'general';

export interface RouteContext {
  indexPubkey: string;
  now: number;
  // Publishing beyond the index's own relay is on.
  outside: boolean;
  // Re-sending what the index's relay already holds: no deletions.
  backfill?: boolean;
}

export interface Routable {
  pubkey: string;
  kind: number;
  tags: string[][];
}

const DAY = 86400;

// When an event's time is over for the general relays: a timed event's
// start, an all-day event's day's end.
export function startOf(event: Routable): number | null {
  const start = event.tags.find((t) => t[0] === 'start')?.[1];
  if (!start) return null;
  if (/^\d+$/.test(start)) return Number(start);
  const date = Date.parse(`${start}T00:00:00Z`);
  return Number.isNaN(date) ? null : date / 1000 + DAY;
}

export function setsFor(event: Routable, ctx: RouteContext): RelaySet[] {
  const { kind } = event;
  const index = event.pubkey === ctx.indexPubkey;
  if (!ctx.outside) return index && (kind === 0 || kind === 10002) ? ['profiles', 'general'] : [];
  switch (kind) {
    case 39998:
    case 39999:
      return ['search', 'lists'];
    case 0:
    case 10002:
      return ['search', 'profiles', 'general'];
    case 3:
      return index ? ['search', 'profiles', 'general'] : [];
    case 31924:
      return ['search', 'general'];
    case 31922:
    case 31923: {
      const start = startOf(event) ?? 0;
      if (start >= ctx.now) return ['search', 'general'];
      return start >= ctx.now - WINDOW_PAST ? ['search'] : [];
    }
    case 5:
      return ctx.backfill ? [] : ['search', 'general'];
    default:
      return [];
  }
}
