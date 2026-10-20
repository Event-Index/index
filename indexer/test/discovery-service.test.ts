import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb } from '../src/store/index-db.ts';
import { openVault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { discoveredStore } from '../src/store/discovered.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, readPage, feedUrlFor, NOW } from './helpers.ts';

const NYC = 'discplace-Izx1rQVSh8njYpP';
const PAGE = 'https://luma.com/nyc';

function service(env: Record<string, string> = {}, pages: Record<string, string> = { [PAGE]: readPage('luma-city-nyc.html') }) {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  const vault = openVault(':memory:', new Uint8Array(randomBytes(32)));
  const indexKey = generateSecretKey();
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const log: string[] = [];
  const feeds = new Map(['luma-city-nyc.ics', 'luma-calendar-craftnook.ics', 'luma-calendar-journaling.ics'].map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const clock = { now: NOW };
  const indexer = createIndexer({
    db, dir, queues: queueStore(db), events: eventStore(db), vault, indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...env }),
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => {
      const fixture = feeds.get(url);
      const text = fixture ? readFixture(fixture) : pages[url];
      return text === undefined ? { status: 'error', code: 'http-404' } : { status: 'ok', text, etag: null, lastModified: null, finalUrl: url };
    },
    publisher: { publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))), rsvps: async () => new Set(), close: () => {} },
    log: (line) => log.push(line),
  });
  const aggregator = identify(`https://api.luma.com/ics/get?entity=discover&id=${NYC}`);
  dir.add({ ...aggregator, pageUrl: PAGE, name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'luma:discover', addedAt: NOW - 86400 });
  return { db, dir, found: discoveredStore(db), sent, log, clock, indexer, indexPubkey: getPublicKey(indexKey) };
}

const follows = (s: ReturnType<typeof service>) =>
  s.sent.filter((x) => x.audience === 'own' && x.event.pubkey === s.indexPubkey && x.event.kind === 3).at(-1)!.event.tags.map((t) => t[1]);

test('the poll service reads an aggregator\'s page, files its named calendars, and polls them at the next tick', async () => {
  const s = service();
  await s.indexer.tick();
  // The fixture page shows 13 named calendars; two have feeds here, the rest answer 404.
  const filed = s.dir.list().filter((e) => e.role === 'calendar').map((e) => e.d).sort();
  assert.ok(filed.includes('luma:cal-BvuRd9eaZnDGBwy'), s.log.join('\n'));
  const craftnook = s.dir.get('luma:cal-BvuRd9eaZnDGBwy')!;
  assert.equal(craftnook.location, 'New York, US');
  assert.equal(craftnook.foundVia, `luma:${NYC}`);
  assert.equal(s.found.since(NOW).filter((f) => f.status === 'skipped').length, 6);

  s.clock.now += 30;
  const report = await s.indexer.tick();
  assert.ok(report.polled.includes('luma:cal-BvuRd9eaZnDGBwy'));
  assert.ok(s.db.recordsOf('luma:cal-BvuRd9eaZnDGBwy').length > 0, 'its records are kept');
  assert.ok(s.sent.every((x) => x.event.pubkey === s.indexPubkey), 'nothing is signed but by the index key');
  assert.deepEqual(follows(s), [], 'the index key follows no one');
});
