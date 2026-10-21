// Discovery (indexer rules § 2): every six hours the index reads each Luma
// city page it lists as an aggregator, once, and takes the calendar of each
// event the page shows. A named public calendar is checked like a submission
// and filed under the page's area, to be polled at the next tick; a
// platform default or a calendar that is not public is skipped, and each skip
// is recorded once. Caps keep a bad page from flooding the directory: new
// calendars per page and run, and calendars filed per day. A step reads at
// most one page and checks a few feeds, so a tick stays short.

import { identify } from '../directory/id.ts';
import { seedFeedUrl } from '../directory/seed.ts';
import { lumaCityPage, type PageEvent } from '../directory/discover.ts';
import { autoApprovable, validateFeed } from '../directory/validate.ts';
import { normalizeFeed, FeedParseError } from '../normalize/normalize.ts';
import type { FetchResult, Validators } from '../poller/fetch.ts';
import type { DirectoryStore, StoredEntry } from '../store/directory.ts';
import type { DiscoveredStore, Found, FoundDetail, FoundStatus } from '../store/discovered.ts';

export const DISCOVERY_INTERVAL = 6 * 3600;
// After a page could not be read.
const RETRY = 3600;
const DAY = 86400;
const NEXT = 'discovery_next ';
const LUMA_PAGE = /^https:\/\/luma\.com\/[A-Za-z0-9_-]+$/;

export interface DiscoverySettings {
  // New calendars one run of one page may take.
  perRun: number;
  // Calendars discovery files in a day.
  perDay: number;
  // Feeds one step checks.
  checksPerStep: number;
}

export interface DiscoveryDeps {
  dir: DirectoryStore;
  found: DiscoveredStore;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  log: (line: string) => void;
  settings: DiscoverySettings;
}

export interface StepReport {
  page: { place: string; error?: string; events: number; calendars: number; queued: number } | null;
  checked: Array<{ d: string; status: FoundStatus; reason: string | null }>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function detailOf(e: PageEvent): FoundDetail {
  return { ...(e.name ? { event: e.name } : {}), ...(e.url ? { url: e.url } : {}), hosts: e.hosts };
}

export function createDiscovery(deps: DiscoveryDeps) {
  const { dir, found, settings } = deps;
  // Notices that would repeat each step are logged once a day.
  const noticed = new Map<string, number>();
  const notice = (key: string, line: string, now: number) => {
    if ((noticed.get(key) ?? -Infinity) > now - DAY) return;
    noticed.set(key, now);
    deps.log(line);
  };
  const cityOf = (entry: StoredEntry | null) => entry?.location?.replace(/, [A-Z]{2}$/, '') ?? entry?.d ?? 'unknown';

  function aggregators(): StoredEntry[] {
    return dir.list().filter((e) => e.role === 'aggregator' && e.source === 'luma' && !!e.pageUrl && LUMA_PAGE.test(e.pageUrl) && !dir.doNotIndex(e.d));
  }

  async function readPage(entry: StoredEntry, now: number): Promise<NonNullable<StepReport['page']>> {
    const placeId = entry.d.slice('luma:'.length);
    const label = `discovery ${cityOf(entry)} (${entry.d})`;
    const fetched = await deps.fetch(entry.pageUrl!, {});
    if (fetched.status !== 'ok') {
      const code = fetched.status === 'error' ? fetched.code : 'not-modified';
      dir.setFact(NEXT + entry.d, String(now + RETRY));
      deps.log(`${label}: page ${entry.pageUrl}: ${code}; tried again in an hour`);
      return { place: entry.d, error: code, events: 0, calendars: 0, queued: 0 };
    }
    dir.setFact(NEXT + entry.d, String(now + DISCOVERY_INTERVAL));
    const page = lumaCityPage(fetched.text);
    if (page.place?.id !== placeId) {
      deps.log(`${label}: the page shows ${page.place?.id ?? 'no place'}, not ${placeId}; nothing taken`);
      return { place: entry.d, error: 'other-place', events: page.events.length, calendars: 0, queued: 0 };
    }
    // The first event shown stands for its calendar.
    const calendars = new Map<string, PageEvent>();
    for (const e of page.events) if (!calendars.has(e.calendar.id)) calendars.set(e.calendar.id, e);
    const n = { queued: 0, known: 0, skipped: 0, waiting: 0, overCap: 0 };
    for (const [id, e] of calendars) {
      const d = `luma:${id}`;
      if (dir.get(d) || dir.doNotIndex(d)) {
        n.known += 1;
        continue;
      }
      const seen = found.get(d);
      if (seen && (seen.status !== 'refused' || (seen.decidedAt ?? 0) > now - DAY)) {
        found.seen(d, now);
        if (seen.status === 'skipped') n.skipped += 1;
        else n.waiting += 1;
        continue;
      }
      const name = e.calendar.name || null;
      const skip = e.calendar.access !== 'public' ? 'not-public' : e.calendar.personal || e.calendar.name === 'Personal' ? 'platform-default-calendar' : null;
      if (skip) {
        found.record({ d, place: entry.d, name, status: 'skipped', reason: skip, detail: detailOf(e), at: now });
        deps.log(`${label}: skipped ${d} (${skip})`);
        n.skipped += 1;
        continue;
      }
      if (n.queued >= settings.perRun) {
        n.overCap += 1;
        continue;
      }
      found.record({ d, place: entry.d, name, status: 'candidate', at: now });
      n.queued += 1;
    }
    deps.log(`${label}: ${plural(page.events.length, 'event')}, ${plural(calendars.size, 'calendar')}: ${n.queued} new to check, `
      + `${n.known} already listed or kept out, ${n.skipped} skipped${n.waiting ? `, ${n.waiting} waiting` : ''}`
      + `${n.overCap ? `, ${n.overCap} over the cap of ${settings.perRun} a run` : ''}`);
    return { place: entry.d, events: page.events.length, calendars: calendars.size, queued: n.queued };
  }

  async function checkOne(c: Found, now: number): Promise<StepReport['checked'][number]> {
    const place = dir.get(c.place);
    const decide = (status: FoundStatus, reason: string | null, name?: string | null) => {
      found.decide(c.d, status, reason, now, name);
      if (status === 'refused') deps.log(`discovery: refused ${c.d}: ${reason}; tried again when seen a day on`);
      if (status === 'skipped') deps.log(`discovery: skipped ${c.d} (${reason})`);
      return { d: c.d, status, reason };
    };
    const identity = identify(seedFeedUrl('luma', c.d.slice('luma:'.length)));
    if (dir.get(identity.d) || dir.doNotIndex(identity.d)) return decide('skipped', 'listed');
    const fetched = await deps.fetch(identity.feedUrl, {});
    if (fetched.status !== 'ok') return decide('refused', fetched.status === 'error' ? fetched.code : 'not-modified');
    const valid = validateFeed(fetched.text);
    if (!valid.ok) return decide('refused', valid.reason);
    let feed;
    try {
      feed = normalizeFeed(fetched.text, identity);
    } catch (error) {
      if (error instanceof FeedParseError) return decide('refused', 'not-icalendar');
      throw error;
    }
    if (feed.calendar.platformDefault) return decide('skipped', 'platform-default-calendar');
    if (!autoApprovable(identity, feed)) return decide('refused', 'no-events');
    dir.add({
      d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
      name: feed.calendar.name, description: null, image: null, location: place?.location ?? null, g: place?.g ?? null, foundVia: c.place, addedAt: now,
    });
    deps.log(`discovery: filed ${identity.d} "${feed.calendar.name ?? ''}" from ${cityOf(place)}`);
    found.decide(c.d, 'filed', null, now, feed.calendar.name);
    return { d: c.d, status: 'filed', reason: null };
  }

  async function check(now: number): Promise<StepReport['checked']> {
    const checked: StepReport['checked'] = [];
    for (const c of found.candidates(settings.checksPerStep)) {
      if (found.filedSince(now - DAY) >= settings.perDay) {
        notice('day', `discovery: filed the cap of ${settings.perDay} a day; discovered calendars wait`, now);
        break;
      }
      checked.push(await checkOne(c, now));
    }
    return checked;
  }

  return {
    async step(now: number): Promise<StepReport> {
      const due = aggregators()
        .map((e) => ({ e, at: Number(dir.fact(NEXT + e.d) ?? 0) }))
        .filter(({ at }) => at <= now)
        .sort((a, b) => a.at - b.at || (a.e.d < b.e.d ? -1 : 1))[0];
      const page = due ? await readPage(due.e, now) : null;
      return { page, checked: await check(now) };
    },
  };
}
