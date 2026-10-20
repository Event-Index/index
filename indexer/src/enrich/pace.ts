// Spaces requests to some hosts: each starts at least the interval after the
// one before it, one at a time, whichever fetch (feed or page) makes it.

import type { FetchResult, Validators } from '../poller/fetch.ts';

type Fetch = (url: string, validators: Validators) => Promise<FetchResult>;

export interface PacerOptions {
  // A host, and its subdomains.
  hosts: string[];
  intervalMs: number;
  // Milliseconds.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function hostPacer(options: PacerOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = -Infinity;
  let queue: Promise<void> = Promise.resolve();
  const paced = (url: string) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return options.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  };
  const turn = () => {
    const mine = queue.then(async () => {
      const wait = last + options.intervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    queue = mine.catch(() => {});
    return mine;
  };
  return {
    wrap: (fetch: Fetch): Fetch => async (url, validators) => {
      if (paced(url)) await turn();
      return fetch(url, validators);
    },
  };
}
