// Discovery (indexer rules § 2): every six hours the index reads each Luma
// city page it lists as an aggregator, once, and takes the calendar of each
// event the page shows; and each listing page it is given (Luma's category
// pages and /discover, seeds/luma-pages.json), taking the calendars shown,
// each under the area it states, or Worldwide. A named public calendar is checked like a submission
// and filed under the page's area, to be polled at the next tick; a
// platform default or a calendar that is not public is skipped, and each skip
// is recorded once. Caps keep a bad page from flooding the directory: new
// calendars per page and run, and calendars filed per day. A step reads at
// most one page and checks a few feeds, so a tick stays short.

import { identify } from '../directory/id.ts';
import { seedFeedUrl } from '../directory/seed.ts';
import { lumaCityPage, lumaListedCalendars, type CalendarPlace, type PageCalendar, type PageEvent } from '../directory/discover.ts';
import { encodeGeohash } from '../project/geohash.ts';
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
// A listing page's key, for its schedule and for what it found.
export const LISTED = 'luma-page:';
// The area of a calendar that states no place.
export const WORLDWIDE = 'Worldwide';
// A calendar's usual area: precision 4 (about 39 km by 20 km), as a city's.
const AREA_PRECISION = 4;

// A Luma listing page discovery reads.
export interface ListedPage {
  slug: string;
  url: string;
}

// ISO 3166 codes by country name, in English first and then in the
// languages a calendar or a group may name its own country in, with the
// names Luma may use besides. Withdrawn and reserved codes are left out
// (DD would be "Deutschland", FX "France"); the first code of a name wins.
const LANGUAGES = ['en', 'de', 'fr', 'nl', 'it', 'es', 'pt', 'ca', 'eu', 'gl', 'ga', 'sv', 'da', 'nb', 'nn', 'fi', 'pl', 'cs', 'sk', 'sl', 'hr', 'hu', 'ro', 'el', 'tr', 'ru', 'uk'];
const NOT_COUNTRIES = new Set(['AN', 'BU', 'CS', 'DD', 'EU', 'EZ', 'FX', 'NT', 'QO', 'QU', 'SU', 'TP', 'UN', 'YU', 'ZR']);
const COUNTRY = (() => {
  const codes = new Map<string, string>();
  for (const language of LANGUAGES) {
    const names = new Intl.DisplayNames([language], { type: 'region' });
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        if (NOT_COUNTRIES.has(code)) continue;
        try {
          const name = names.of(code)?.toLowerCase();
          if (name && name !== code.toLowerCase() && !codes.has(name)) codes.set(name, code);
        } catch { /* not a region */ }
      }
    }
  }
  for (const [name, code] of [['turkey', 'TR'], ['czech republic', 'CZ'], ['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['korea', 'KR'], ['russia', 'RU'], ['vietnam', 'VN'],
    ['hong kong', 'HK'], ['macau', 'MO'], ['macao', 'MO']] as const) codes.set(name, code);
  return codes;
})();

// The area a calendar found on a listing page states: its city, with its
// country's code where known, and a geohash where it gives a point; with no
// city, Worldwide and no geohash.
export function areaOf(place: CalendarPlace | null): { location: string; g: string | null } {
  if (!place) return { location: WORLDWIDE, g: null };
  const country = place.country ? COUNTRY.get(place.country.toLowerCase()) ?? place.country : null;
  return {
    location: country ? `${place.city}, ${country}` : place.city,
    g: place.latitude !== null && place.longitude !== null ? encodeGeohash(place.latitude, place.longitude, AREA_PRECISION) : null,
  };
}

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
  // The listing pages read besides the city pages.
  listedPages?: ListedPage[];
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

  // What a page shows: each calendar not yet known is skipped (a platform
  // default, or not public) or waits to be checked, at most the cap a run.
  function take(label: string, place: string, shown: Array<{ calendar: PageCalendar; detail: FoundDetail }>, now: number) {
    const n = { queued: 0, known: 0, skipped: 0, waiting: 0, overCap: 0 };
    for (const { calendar, detail } of shown) {
      const d = `luma:${calendar.id}`;
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
      const name = calendar.name || null;
      const skip = calendar.access !== 'public' ? 'not-public' : calendar.personal || calendar.name === 'Personal' ? 'platform-default-calendar' : null;
      if (skip) {
        found.record({ d, place, name, status: 'skipped', reason: skip, detail, at: now });
        deps.log(`${label}: skipped ${d} (${skip})`);
        n.skipped += 1;
        continue;
      }
      if (n.queued >= settings.perRun) {
        n.overCap += 1;
        continue;
      }
      found.record({ d, place, name, status: 'candidate', detail, at: now });
      n.queued += 1;
    }
    return n;
  }
  const summary = (n: ReturnType<typeof take>) => `${n.queued} new to check, ${n.known} already listed or kept out, ${n.skipped} skipped${n.waiting ? `, ${n.waiting} waiting` : ''}`
    + `${n.overCap ? `, ${n.overCap} over the cap of ${settings.perRun} a run` : ''}`;

  async function readListed(page: ListedPage, now: number): Promise<NonNullable<StepReport['page']>> {
    const key = LISTED + page.slug;
    const label = `discovery ${page.url}`;
    if (!LUMA_PAGE.test(page.url)) {
      dir.setFact(NEXT + key, String(now + DISCOVERY_INTERVAL));
      return { place: key, error: 'not-a-luma-page', events: 0, calendars: 0, queued: 0 };
    }
    const fetched = await deps.fetch(page.url, {});
    if (fetched.status !== 'ok') {
      const code = fetched.status === 'error' ? fetched.code : 'not-modified';
      dir.setFact(NEXT + key, String(now + RETRY));
      deps.log(`${label}: ${code}; tried again in an hour`);
      return { place: key, error: code, events: 0, calendars: 0, queued: 0 };
    }
    dir.setFact(NEXT + key, String(now + DISCOVERY_INTERVAL));
    const calendars = lumaListedCalendars(fetched.text);
    const n = take(label, key, calendars.map((calendar) => ({ calendar, detail: { area: areaOf(calendar.place) } })), now);
    deps.log(`${label}: ${plural(calendars.length, 'calendar')}: ${summary(n)}`);
    return { place: key, events: 0, calendars: calendars.length, queued: n.queued };
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
    const n = take(label, entry.d, [...calendars.values()].map((e) => ({ calendar: e.calendar, detail: detailOf(e) })), now);
    deps.log(`${label}: ${plural(page.events.length, 'event')}, ${plural(calendars.size, 'calendar')}: ${summary(n)}`);
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
    // Under its city page's area, or the area a listing page showed it with.
    const area = place ? { location: place.location, g: place.g } : c.detail?.area ?? { location: WORLDWIDE, g: null };
    dir.add({
      d: identity.d, role: identity.role, source: identity.source, feedUrl: identity.feedUrl, pageUrl: identity.pageUrl,
      name: feed.calendar.name, description: null, image: null, location: area.location, g: area.g, foundVia: c.place, addedAt: now,
    });
    deps.log(`discovery: filed ${identity.d} "${feed.calendar.name ?? ''}" from ${place ? cityOf(place) : c.place} (${area.location})`);
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
      // City pages and listing pages alike: the one due longest is read.
      const due = [
        ...aggregators().map((e) => ({ key: e.d, read: () => readPage(e, now) })),
        ...(deps.listedPages ?? []).map((p) => ({ key: LISTED + p.slug, read: () => readListed(p, now) })),
      ]
        .map((input) => ({ ...input, at: Number(dir.fact(NEXT + input.key) ?? 0) }))
        .filter(({ at }) => at <= now)
        .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))[0];
      const page = due ? await due.read() : null;
      return { page, checked: await check(now) };
    },
  };
}
