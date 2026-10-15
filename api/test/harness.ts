// A populated index (fixture feeds polled by the poll service at the fixture
// clock) and an API server over it on a free local port.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { openIndexDb } from '../../indexer/src/store/index-db.ts';
import { openVault } from '../../indexer/src/store/vault-db.ts';
import { directoryStore, type Entry } from '../../indexer/src/store/directory.ts';
import { queueStore } from '../../indexer/src/store/queues.ts';
import { eventStore } from '../../indexer/src/store/events.ts';
import { createIndexer } from '../../indexer/src/service/indexer.ts';
import { loadSettings } from '../../indexer/src/config.ts';
import { identify } from '../../indexer/src/directory/id.ts';
import type { Cities } from '../../indexer/src/service/admin.ts';
import type { FetchResult } from '../../indexer/src/poller/fetch.ts';
import { createApi } from '../src/server.ts';
import { readFixture, feedUrlFor, NOW } from '../../indexer/test/helpers.ts';

const repo = new URL('../../', import.meta.url).pathname;
export const cities = JSON.parse(readFileSync(join(repo, 'seeds/cities.json'), 'utf8')) as Cities;

export const FIXTURES: Record<string, Partial<Entry>> = {
  'meetup-pythonsd.ics': { location: 'San Diego, US', g: '9mud' },
  'luma-calendar-craftnook.ics': { location: 'New York, US', g: 'dr5r' },
  'luma-calendar-journaling.ics': { location: 'New York, US', g: 'dr5r' },
  'mobilizon-lyontechhub.ics': { location: 'Lyon, FR', g: 'u05k' },
  'google-kubernetes-sig-cli.ics': {},
};

export interface Harness {
  base: string;
  dataDir: string;
  indexPubkey: string;
  clock: { now: number };
  db: ReturnType<typeof openIndexDb>;
  dir: ReturnType<typeof directoryStore>;
  queues: ReturnType<typeof queueStore>;
  events: ReturnType<typeof eventStore>;
  indexer: ReturnType<typeof createIndexer>;
  // Feeds the API's own fetch (for submissions) answers with.
  feeds: Map<string, FetchResult>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

export async function harness(options: { queueCap?: number } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-'));
  const settings = loadSettings({ EVENTINDEX_DATA_DIR: dataDir, EVENTINDEX_INDEX_KEY_FILE: '/nonexistent', EVENTINDEX_CALENDAR_SECRET_FILE: '/nonexistent' });
  const db = openIndexDb(settings.indexDb);
  const dir = directoryStore(db);
  const queues = queueStore(db);
  const events = eventStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const clock = { now: NOW };
  const urls = new Map(Object.keys(FIXTURES).map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const indexer = createIndexer({
    db, dir, queues, events, vault, indexKey, settings,
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => {
      const fixture = urls.get(url);
      return fixture ? { status: 'ok', text: readFixture(fixture), etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' };
    },
    publisher: { publish: async () => {}, rsvps: async () => new Set(), close: () => {} },
    log: () => {},
  });
  for (const [fixture, extra] of Object.entries(FIXTURES)) {
    const id = identify(feedUrlFor(fixture));
    dir.add({ d: id.d, role: id.role, source: id.source, feedUrl: id.feedUrl, pageUrl: id.pageUrl, name: null, description: null, image: null,
      location: null, g: null, foundVia: 'maintainer', addedAt: NOW - 86400, ...extra });
  }
  await indexer.tick();
  // A second round, as the service has after one cycle: each calendar now
  // polls knowing every other's events, so co-hosts agree.
  for (const entry of dir.list()) db.savePollState(entry.d, { ...db.pollState(entry.d), nextPollAt: 0 });
  await indexer.tick();

  const feeds = new Map<string, FetchResult>();
  const handler = createApi({
    db, dir, queues, events, settings, cities,
    now: () => clock.now,
    fetch: async (url) => feeds.get(url) ?? { status: 'error', code: 'http-404' },
    ...(options.queueCap ? { limits: { queueCap: options.queueCap } } : {}),
  });
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, dataDir, indexPubkey: getPublicKey(indexKey), clock, db, dir, queues, events, indexer, feeds,
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers }),
    post: (path, body, headers = {}) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: typeof body === 'string' ? { 'content-type': 'application/x-www-form-urlencoded', ...headers } : { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vault.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
