// Reads the pages of upcoming Meetup events for what their feeds leave out
// (spec/platform-adapters.md, Meetup): an event's page once when the event
// is first seen, and again only when its feed's LAST-MODIFIED or SEQUENCE
// changes, with the validators of the last read. Only what robots.txt
// allows is requested, robots.txt itself once a day. A 403 or 429 pauses
// reading, longer each time in a row, and five in a row stop it until the
// operator resumes it. A step reads a few pages; the fetch it is given
// spaces requests to the site (pace.ts).

import { readEventPage, type PageFacts } from './event-page.ts';
import { robotsAllows } from './robots.ts';
import type { EventPagesStore } from '../store/event-pages.ts';
import type { FetchResult, Validators } from '../poller/fetch.ts';

export const ROBOTS_URL = 'https://www.meetup.com/robots.txt';
// The product token robots.txt is read for (fetch.ts USER_AGENT).
const AGENT = 'EventIndex';
const ROBOTS_TTL = 86400;
const ROBOTS_RETRY = 3600;
const RETRY = 3600;
const MAX_ATTEMPTS = 5;
const PAUSE = 600;
const MAX_PAUSE = 86400;
const STRIKES_TO_STOP = 5;

export interface PageReaderDeps {
  store: EventPagesStore;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  log: (line: string) => void;
}

export interface Changed {
  calendarD: string;
  uid: string;
}

const same = (a: PageFacts | null, b: PageFacts | null) => JSON.stringify(a) === JSON.stringify(b);
const refusal = (r: FetchResult) => r.status === 'error' && (r.code === 'http-403' || r.code === 'http-429');

export function createPageReader(deps: PageReaderDeps) {
  const { store } = deps;

  // A 403 or 429: the reader pauses, or stops.
  function refused(result: FetchResult & { status: 'error' }, now: number): void {
    const strikes = store.state().strikes + 1;
    if (strikes >= STRIKES_TO_STOP) {
      store.refused(strikes, null, now);
      deps.log(`meetup pages: stopped after ${strikes} refusals in a row (${result.code}); eventindex-admin meetup-pages resume starts them again`);
      return;
    }
    const wait = Math.min(MAX_PAUSE, Math.max(PAUSE * 2 ** (strikes - 1), (result.retryAfter ?? 0) - now));
    store.refused(strikes, now + wait, null);
    deps.log(`meetup pages: ${result.code}, paused for ${wait} s`);
  }

  // The robots.txt to read pages by, or null while there is none to go by.
  async function robots(now: number): Promise<string | null> {
    const state = store.state();
    if (state.robots !== null && (state.robotsAt ?? 0) > now - ROBOTS_TTL) return state.robots;
    if ((state.robotsRetryAt ?? 0) > now) return null;
    const result = await deps.fetch(ROBOTS_URL, {});
    if (result.status === 'ok') {
      store.setRobots(result.text, now, null);
      return result.text;
    }
    if (refusal(result)) {
      refused(result as FetchResult & { status: 'error' }, now);
      return null;
    }
    // A site without a robots.txt (any other 4xx) allows everything.
    if (result.status === 'error' && /^http-4\d\d$/.test(result.code)) {
      store.setRobots('', now, null);
      return '';
    }
    store.setRobots(null, now, now + ROBOTS_RETRY);
    deps.log(`meetup pages: robots.txt: ${result.status === 'error' ? result.code : result.status}; pages wait`);
    return null;
  }

  return {
    async step(now: number, limit: number): Promise<Changed[]> {
      const state = store.state();
      if (state.stoppedAt !== null || (state.pausedUntil ?? 0) > now) return [];
      const due = store.due(now, limit);
      if (due.length === 0) return [];
      const rules = await robots(now);
      if (rules === null) return [];
      const changed: Changed[] = [];
      for (const row of due) {
        const key = { calendarD: row.calendarD, uid: row.uid };
        const done = (facts: PageFacts | null, outcome: 'read' | 'disallowed' | 'gone', validators: { etag?: string | null; lastModified?: string | null } = {}) => {
          store.read(row.calendarD, row.uid, { stamp: row.feed.stamp, at: now, outcome, facts, ...validators });
          if (!same(row.facts, facts)) changed.push(key);
        };
        const url = new URL(row.url);
        if (!robotsAllows(rules, AGENT, `${url.pathname}${url.search}`)) {
          done(null, 'disallowed');
          continue;
        }
        const result = await deps.fetch(row.url, { etag: row.etag, lastModified: row.lastModified });
        if (result.status === 'ok') {
          done(readEventPage(result.text), 'read', { etag: result.etag, lastModified: result.lastModified });
        } else if (result.status === 'not-modified') {
          done(row.facts, 'read');
        } else if (refusal(result)) {
          refused(result, now);
          break;
        } else if (result.code === 'http-404' || result.code === 'http-410') {
          done(null, 'gone');
        } else {
          store.failed(row.calendarD, row.uid, now + RETRY, MAX_ATTEMPTS);
          continue;
        }
        store.answered();
      }
      return changed;
    },
  };
}
