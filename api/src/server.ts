// The HTTP service: the API under /api/1.0/, NIP-05 names, and the pages of
// eventindex.space. It reads index.db and writes only to the review queues;
// it holds no key.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { decode } from 'nostr-tools/nip19';
import type { Settings } from '../../indexer/src/config.ts';
import { identify } from '../../indexer/src/directory/id.ts';
import { toIcs, toJcal, publicCalendar } from '../../indexer/src/project/public.ts';
import type { FetchResult, Validators } from '../../indexer/src/poller/fetch.ts';
import type { Cities } from '../../indexer/src/service/admin.ts';
import type { IndexDb } from '../../indexer/src/store/index-db.ts';
import type { DirectoryStore, StoredEntry } from '../../indexer/src/store/directory.ts';
import type { QueueStore } from '../../indexer/src/store/queues.ts';
import type { EventStore } from '../../indexer/src/store/events.ts';
import { npubEncode } from 'nostr-tools/nip19';
import { LIMITS, rateLimiter, type Limits } from './limits.ts';
import type { RelayReader } from '../../indexer/src/native/read.ts';
import { calendarView, documentJsonLd, eventDocument, eventList, feedOf, feedWindow, statsView, withoutCopies, type Format, type ViewDeps } from './views.ts';
import { submitFeed, requestRemoval, type Outcome } from './writes.ts';
import { fileNative, ownerAction, requestClaim, verifyClaimNip05, type ClaimDeps } from './claims.ts';
import { checkAuth } from '../../indexer/src/claim/auth.ts';
import { brandFiles } from './brand.ts';
import { CSP, STYLE, calendarPage, calendarsPage, homePage, messagePage, removeResultPage, submitResultPage } from './pages.ts';
import { cityCounts, cityZones, comingUp, dayGrid } from './home.ts';

export interface ApiDeps {
  db: IndexDb;
  dir: DirectoryStore;
  queues: QueueStore;
  events: EventStore;
  settings: Settings;
  cities: Cities;
  now: () => number;
  fetch: (url: string, validators: Validators) => Promise<FetchResult>;
  // Reads organizers' own events from relays (filing a native calendar).
  reader?: RelayReader;
  relayAllowed?: (url: string) => Promise<boolean>;
  limits?: Partial<Limits>;
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const API = '/api/1.0';
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;
const EVENT_ID = /^[a-z2-7]{32}$/;
const YEAR = 365 * 86400;
// Geohash cell widths in km by precision, for `radius`.
const CELL_KM = [Infinity, 5000, 1250, 156, 39.1, 4.89, 1.22, 0.153, 0.0382, 0.00477];

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  ({ status, type: JSON_TYPE, body: JSON.stringify(body), headers });
const html = (status: number, body: string): Reply => ({ status, type: HTML_TYPE, body, headers: { 'Content-Security-Policy': CSP } });
const outcomeJson = (o: Outcome, retry?: number): Reply => json(o.status, o.body, retry ? { 'Retry-After': String(retry) } : {});
const via = (entry: StoredEntry) => ({ Link: `<${entry.feedUrl}>; rel="via"` });

// X-Real-IP is the reader's address only when nginx, on this host, set it.
export function clientAddress(req: Pick<IncomingMessage, 'socket' | 'headers'>): string {
  const socket = req.socket.remoteAddress ?? '';
  const fromProxy = socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-real-ip'];
  return fromProxy && typeof forwarded === 'string' && forwarded ? forwarded : socket;
}

async function readText(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) throw new HttpError(413, 'too-large', `The request body can be at most ${max} bytes.`);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return parseBody(req, await readText(req, max));
}

function parseBody(req: IncomingMessage, text: string): Record<string, unknown> {
  if (!text) return {};
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'invalid-body', 'The body must be a JSON object or a form.');
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const value = params.get(name);
  if (value === null || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) throw new HttpError(400, 'invalid-parameter', `${name} must be a unix time in seconds.`);
  return Number(value);
}

function nearParam(params: URLSearchParams): string | undefined {
  const near = params.get('near')?.toLowerCase();
  const radius = params.get('radius');
  if (radius !== null && radius !== '' && !near) throw new HttpError(400, 'invalid-parameter', 'radius needs near.');
  if (!near) return undefined;
  if (!GEOHASH.test(near)) throw new HttpError(400, 'invalid-parameter', 'near must be a geohash.');
  if (radius === null || radius === '') return near;
  const km = Number(radius);
  if (!(km > 0)) throw new HttpError(400, 'invalid-parameter', 'radius must be a positive number of kilometres.');
  let precision = 1;
  while (precision + 1 < CELL_KM.length && CELL_KM[precision + 1]! >= km) precision += 1;
  return near.slice(0, precision);
}

function limitParam(params: URLSearchParams, fallback: number): number {
  const limit = intParam(params, 'limit', fallback);
  if (limit < 1) throw new HttpError(400, 'invalid-parameter', 'limit must be at least 1.');
  return Math.min(limit, 500);
}

// "<name>", "<name>.ics" or "<name>.json".
function splitFormat(segment: string): { name: string; suffix: '' | '.ics' | '.json' } {
  const match = /^(.*?)(\.ics|\.json)?$/.exec(segment)!;
  return { name: match[1]!, suffix: (match[2] ?? '') as '' | '.ics' | '.json' };
}

export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const limits: Limits = { ...LIMITS, ...deps.limits };
  const limiter = rateLimiter();
  const view: ViewDeps = deps;
  const { dir, events, settings } = deps;
  const log = deps.log ?? (() => {});
  const writes = { dir, queues: deps.queues, fetch: deps.fetch, limits, domain: settings.domain, log };
  const claims: ClaimDeps = { ...writes, settings, cities: deps.cities, ...(deps.reader ? { reader: deps.reader } : {}), ...(deps.relayAllowed ? { relayAllowed: deps.relayAllowed } : {}) };
  const brand = brandFiles();

  const notFound = (what = 'Not found.'): never => { throw new HttpError(404, 'not-found', what); };
  const listedCalendar = (name: string): StoredEntry => {
    const entry = dir.byLocalName(decodeURIComponent(name));
    if (!entry) return notFound('There is no such calendar in the directory.');
    return entry;
  };
  const indexedCalendar = (name: string): StoredEntry => {
    const entry = listedCalendar(name);
    if (entry.removed) throw new HttpError(410, 'removed', 'This calendar is no longer indexed, at its organizer\'s request.');
    return entry;
  };
  const limited = (kind: string, req: IncomingMessage, perHour: number, now: number): number | null =>
    limiter.take(`${kind} ${clientAddress(req)}`, perHour, now);

  function calendarSearch(params: URLSearchParams): StoredEntry[] {
    const q = params.get('q')?.trim() || undefined;
    const near = nearParam(params);
    const tag = params.get('tag')?.trim().toLowerCase() || undefined;
    const limit = limitParam(params, 50);
    let found = dir.search({ q, near, limit: tag ? 500 : limit });
    if (tag) {
      const tagged = new Set(events.calendarsWithTag(tag));
      found = found.filter((e) => tagged.has(e.d)).slice(0, limit);
    }
    return found;
  }

  async function api(req: IncomingMessage, url: URL, now: number): Promise<Reply> {
    const path = url.pathname.slice(API.length);
    const params = url.searchParams;
    const parts = path.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'POST') {
      // Requests signed with the organizer's own key (NIP-98).
      const native = path === '/calendars/native';
      const claim = parts.length === 3 && parts[0] === 'calendars' && parts[2] === 'claim';
      const nip05 = parts.length === 5 && parts[0] === 'calendars' && parts[2] === 'claim' && parts[4] === 'nip05' && /^\d+$/.test(parts[3]!);
      const signer = parts.length === 3 && parts[0] === 'calendars' && parts[2] === 'signer';
      if (native || claim || nip05 || signer) {
        const text = await readText(req, limits.maxBodyBytes);
        const auth = checkAuth(req.headers['authorization'], {
          urls: [`${settings.apiBase}${path}`, `https://${settings.domain}${API}${path}`], method: 'POST', body: text, now,
        });
        if (!auth.ok) return json(401, { error: 'unauthorized', reason: auth.reason, message: 'Sign this request with your nostr key (NIP-98).' });
        if (!deps.queues.useAuth(auth.eventId, now)) return json(401, { error: 'unauthorized', reason: 'used', message: 'This signature was used before. Sign the request again.' });
        const wait = limited('key', req, limits.keyRequestsPerHour, now);
        if (wait) return json(429, { error: 'rate-limited', message: 'Too many requests from this address. Try again later.' }, { 'Retry-After': String(wait) });
        const body = parseBody(req, text);
        if (native) return outcomeJson(await fileNative(claims, auth.pubkey, body, now));
        const entry = dir.byLocalName(decodeURIComponent(parts[1]!));
        if (claim) return outcomeJson(requestClaim(claims, entry, auth.pubkey, body, now));
        if (nip05) return outcomeJson(await verifyClaimNip05(claims, entry, Number(parts[3]), auth.pubkey, body, now));
        return outcomeJson(ownerAction(claims, entry, auth.pubkey, body, now));
      }
      if (path === '/feeds/add') {
        const body = await readBody(req, limits.maxBodyBytes);
        const wait = limited('add', req, limits.submitsPerHour, now);
        if (wait) return json(429, { error: 'rate-limited', message: 'Too many submissions from this address. Try again later.' }, { 'Retry-After': String(wait) });
        return outcomeJson(await submitFeed(writes, body['url'] ?? params.get('url'), now));
      }
      if (parts.length === 3 && parts[0] === 'calendars' && parts[2] === 'remove-request') {
        const body = await readBody(req, limits.maxBodyBytes);
        const wait = limited('remove', req, limits.removeRequestsPerHour, now);
        if (wait) return json(429, { error: 'rate-limited', message: 'Too many requests from this address. Try again later.' }, { 'Retry-After': String(wait) });
        return outcomeJson(requestRemoval(writes, dir.byLocalName(decodeURIComponent(parts[1]!)), body['message'], now));
      }
      throw new HttpError(405, 'method-not-allowed', 'This address takes GET.');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method-not-allowed', 'The API takes GET and POST.');

    const [area, how, arg] = parts;
    if (area === 'calendars' && parts.length === 2 && how === 'byfeedurl') {
      const feedUrl = params.get('url');
      if (!feedUrl) throw new HttpError(400, 'invalid-parameter', 'url is required.');
      let d: string | null = null;
      try {
        d = identify(feedUrl).d;
      } catch {
        // Not a URL the index can identify; look it up as written.
      }
      const entry = (d ? dir.get(d) : null) ?? dir.byFeedUrl(feedUrl);
      return entry ? json(200, calendarView(view, entry)) : notFound('No calendar in the directory has this feed.');
    }
    if (area === 'calendars' && parts.length === 3 && how === 'byslug') return json(200, calendarView(view, listedCalendar(arg!)));
    if (area === 'calendars' && parts.length === 3 && how === 'byguid') {
      let pubkey = arg!.toLowerCase();
      if (pubkey.startsWith('npub1')) {
        try {
          pubkey = decode(arg! as `npub1${string}`).data as string;
        } catch {
          notFound();
        }
      }
      const entry = dir.byPubkey(pubkey) ?? dir.byOwner(pubkey)[0] ?? null;
      return entry ? json(200, calendarView(view, entry)) : notFound('No calendar in the directory has this key.');
    }
    if (area === 'search' && how === 'calendars' && arg === 'byterm' && parts.length === 3) {
      const found = calendarSearch(params);
      return json(200, { calendars: found.map((e) => calendarView(view, e)), count: found.length });
    }
    if (area === 'events' && how === 'byid' && parts.length === 3) {
      const { name: id, suffix } = splitFormat(arg!);
      if (!EVENT_ID.test(id)) notFound('There is no such event.');
      const doc = eventDocument(view, id, now);
      if (doc.status === 'removed') throw new HttpError(410, 'removed', 'This event\'s calendar is no longer indexed, at its organizer\'s request.');
      if (doc.status === 'not-found') return notFound('There is no such event.');
      const headers = via(doc.loaded.entry);
      if (suffix === '.ics') return { status: 200, type: 'text/calendar; charset=utf-8', body: toIcs(publicCalendar(doc.loaded.record, doc.occurrence, doc.loaded.ctx)), headers };
      if (suffix === '.json') {
        const ld = documentJsonLd(doc);
        return ld ? { status: 200, type: 'application/ld+json; charset=utf-8', body: JSON.stringify(ld), headers } : notFound('There is no such event.');
      }
      return { status: 200, type: 'application/calendar+json; charset=utf-8', body: JSON.stringify(toJcal(publicCalendar(doc.loaded.record, doc.occurrence, doc.loaded.ctx))), headers };
    }
    if (area === 'events' && how === 'bycalendar' && parts.length === 3) {
      const { name, suffix } = splitFormat(arg!);
      if (suffix === '.ics') notFound();
      const entry = indexedCalendar(name);
      const window = feedWindow(now);
      const rows = events.byCalendar(entry.d, intParam(params, 'from', window.from), intParam(params, 'to', window.to), limitParam(params, 500));
      return json(200, eventList(view, rows, (suffix === '.json' ? 'json' : 'jcal') as Format, now), via(entry));
    }
    if (area === 'search' && how === 'events' && parts.length === 3 && splitFormat(arg!).name === 'byterm') {
      const { suffix } = splitFormat(arg!);
      const from = intParam(params, 'from', now);
      const rows = events.search({
        q: params.get('q')?.trim() || undefined,
        from,
        to: intParam(params, 'to', from + YEAR),
        near: nearParam(params),
        tag: params.get('tag')?.trim().toLowerCase() || undefined,
        limit: limitParam(params, 100),
      });
      return json(200, eventList(view, rows, (suffix === '.json' ? 'json' : 'jcal') as Format, now));
    }
    if (area === 'ics' && how === 'calendar' && parts.length === 3 && arg!.endsWith('.ics')) {
      const entry = indexedCalendar(arg!.slice(0, -4));
      const window = feedWindow(now);
      const rows = events.byCalendar(entry.d, window.from, window.to, 10_000);
      return { status: 200, type: 'text/calendar; charset=utf-8', body: feedOf(view, entry.name ?? entry.d, entry.pageUrl, rows, now), headers: via(entry) };
    }
    if (area === 'ics' && how === 'city' && parts.length === 3 && arg!.endsWith('.ics')) {
      const city = deps.cities.cities.find((c) => c.slug === arg!.slice(0, -4));
      if (!city) return notFound('There is no such city in the directory.');
      const place = `${city.name}, ${city.country}`;
      const calendars = dir.list().filter((e) => e.role === 'calendar' && e.location === place).map((e) => e.d);
      const window = feedWindow(now);
      const rows = calendars.length ? withoutCopies(events.search({ from: window.from, to: window.to, calendars, limit: 500 })) : [];
      return { status: 200, type: 'text/calendar; charset=utf-8', body: feedOf(view, `Events in ${city.name}`, `https://${settings.domain}/`, rows, now) };
    }
    if (path === '/stats') return json(200, statsView(view, now));
    if (path === '/dump/index.db') {
      let body: Buffer;
      try {
        statSync(settings.dumpFile);
        body = readFileSync(settings.dumpFile);
      } catch {
        return notFound('The first dump has not been made yet.');
      }
      return { status: 200, type: 'application/vnd.sqlite3', body, headers: { 'Content-Disposition': 'attachment; filename="index.db"' } };
    }
    return notFound();
  }

  function nostrJson(url: URL): Reply {
    const name = url.searchParams.get('name')?.trim().toLowerCase();
    const names: Record<string, string> = {};
    const indexPubkey = dir.fact('index_pubkey');
    if ((!name || name === '_') && indexPubkey) names['_'] = indexPubkey;
    if (name && name !== '_') {
      const pubkey = dir.byLocalName(name)?.pubkey;
      if (pubkey) names[name] = pubkey;
    }
    const keys = Object.values(names);
    return json(200, keys.length ? { names, relays: Object.fromEntries(keys.map((k) => [k, [settings.publicRelay]])) } : { names });
  }

  async function page(req: IncomingMessage, url: URL, now: number): Promise<Reply> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'POST' && url.pathname === '/submit') {
      const body = await readBody(req, limits.maxBodyBytes);
      if (limited('add', req, limits.submitsPerHour, now)) return html(429, messagePage('Too many submissions', 'Too many submissions from this address. Try again later.'));
      const outcome = await submitFeed(writes, body['url'], now);
      return html(outcome.status, submitResultPage(outcome));
    }
    if (method === 'POST' && parts.length === 3 && parts[0] === 'calendar' && parts[2] === 'remove') {
      const body = await readBody(req, limits.maxBodyBytes);
      const entry = dir.byLocalName(decodeURIComponent(parts[1]!));
      if (limited('remove', req, limits.removeRequestsPerHour, now)) return html(429, messagePage('Too many requests', 'Too many requests from this address. Try again later.'));
      const outcome = requestRemoval(writes, entry, body['message'], now);
      return html(outcome.status, removeResultPage(entry, outcome));
    }
    if (method !== 'GET' && method !== 'HEAD') return html(405, messagePage('Not allowed', 'This page takes GET.'));
    if (url.pathname === '/') {
      const indexPubkey = dir.fact('index_pubkey');
      const entries = dir.list();
      const zones = cityZones(entries, deps.cities);
      const zoned = <T extends { calendarD: string; tzid: string | null }>(r: T): T => ({ ...r, tzid: r.tzid ?? zones.get(r.calendarD) ?? null });
      // Four weeks from this Monday, with a day's margin for zones.
      const days = dayGrid(events.startsBetween(now - 8 * 86400, now + 29 * 86400).map(zoned), now).days;
      return html(200, homePage({
        stats: statsView(view, now),
        days,
        upcoming: comingUp(events.search({ from: now, to: now + 30 * 86400, limit: 500 }).map(zoned), entries, now, 6),
        cities: cityCounts(entries, deps.cities),
        settings,
        indexNpub: indexPubkey ? npubEncode(indexPubkey) : null,
      }));
    }
    if (url.pathname === '/style.css') return { status: 200, type: 'text/css; charset=utf-8', body: STYLE };
    const file = brand.get(url.pathname);
    if (file) {
      const headers: Record<string, string> = { 'Cache-Control': 'public, max-age=86400' };
      // An SVG opened on its own runs nothing and loads nothing.
      if (file.type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
      return { status: 200, type: file.type, body: file.body, headers };
    }
    if (url.pathname === '/calendars' || url.pathname === '/search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      const entries = dir.list();
      const cities = cityCounts(entries, deps.cities);
      const city = cities.find((c) => c.slug === url.searchParams.get('city')) ?? null;
      // An aggregator only leads to calendars: it is not one to list.
      let found = (q ? calendarSearch(new URLSearchParams({ q, limit: '500' })) : entries).filter((e) => e.role === 'calendar');
      if (city) found = found.filter((e) => cityCounts([e], deps.cities)[0]?.slug === city.slug);
      const counts = events.upcomingByCalendar(now);
      const items = found.map((entry) => ({ entry, upcoming: counts.get(entry.d) ?? 0 }))
        .sort((a, b) => b.upcoming - a.upcoming || (a.entry.name ?? a.entry.d).localeCompare(b.entry.name ?? b.entry.d));
      return html(200, calendarsPage({ q, city, items, cities }));
    }
    if (parts.length === 2 && parts[0] === 'calendar') {
      const entry = dir.byLocalName(decodeURIComponent(parts[1]!));
      if (!entry) return html(404, messagePage('No such calendar', 'There is no such calendar in the directory.'));
      const zone = cityZones([entry], deps.cities).get(entry.d) ?? (dir.calendarMeta(entry.d) as { timezone?: string | null } | null)?.timezone ?? null;
      const upcoming = entry.removed ? [] : events.byCalendar(entry.d, now, now + YEAR, 50).map((r) => ({ ...r, tzid: r.tzid ?? zone }));
      return html(200, calendarPage(entry, calendarView(view, entry), upcoming, settings));
    }
    return html(404, messagePage('Not found', 'There is nothing at this address.'));
  }

  return (req, res) => {
    const now = deps.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isApi = url.pathname === API || url.pathname.startsWith(`${API}/`);
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    const send = (reply: Reply) => {
      const cache = req.method === 'GET' && reply.status === 200 ? 'public, max-age=300' : 'no-store';
      res.writeHead(reply.status, { ...headers, 'Content-Type': reply.type, 'Cache-Control': cache, ...reply.headers });
      res.end(req.method === 'HEAD' ? undefined : reply.body);
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    const work = isApi ? api(req, url, now) : url.pathname === '/.well-known/nostr.json' ? Promise.resolve(nostrJson(url)) : page(req, url, now);
    work.then(send, (error: unknown) => {
      if (error instanceof HttpError) {
        send(isApi || url.pathname.startsWith('/.well-known/')
          ? json(error.status, { error: error.code, message: error.message })
          : html(error.status, messagePage(error.status === 404 ? 'Not found' : 'Something is wrong with the request', error.message)));
        return;
      }
      log(`${req.method} ${url.pathname}: ${(error as Error).stack ?? error}`);
      send(isApi ? json(500, { error: 'internal', message: 'Something went wrong on our side.' }) : html(500, messagePage('Something went wrong', 'Something went wrong on our side.')));
    });
  };
}
