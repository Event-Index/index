import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb, type IndexDb } from '../src/store/index-db.ts';
import { openVault, type Vault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { retirementStore } from '../src/store/retirement.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { retireCalendarKeys, destroyCalendarKeys } from '../src/service/admin.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const FIXTURES = ['luma-calendar-craftnook.ics', 'luma-calendar-journaling.ics'];
const HEADER = `39998:${'ab'.repeat(32)}:events`;
const OUTSIDE = {
  EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE: '1',
  EVENTINDEX_SEARCH_RELAYS: 'wss://search.test', EVENTINDEX_GENERAL_RELAYS: 'wss://general.test',
  EVENTINDEX_LIST_RELAYS: 'wss://lists.test', EVENTINDEX_PROFILE_RELAYS: 'wss://profiles.test',
};
// As live: calendar keys paused, event items on.
const LIVE = { EVENTINDEX_CALENDAR_KEYS_PAUSED: '1', EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER };

interface Stores { db: IndexDb; vault: Vault; indexKey: Uint8Array; allowlist: string }
const stores = (): Stores => ({
  db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey(),
  allowlist: join(mkdtempSync(join(tmpdir(), 'allow-')), 'relay-allowlist.json'),
});

function service(s: Stores, env: Record<string, string>, options: { pending?: () => number; at?: number } = {}) {
  const dir = directoryStore(s.db);
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const log: string[] = [];
  const urls = new Map(FIXTURES.map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const indexer = createIndexer({
    db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', EVENTINDEX_RELAY_ALLOWLIST: s.allowlist, ...OUTSIDE, ...env }),
    now: () => options.at ?? NOW,
    fetch: async (u): Promise<FetchResult> => {
      const f = urls.get(u);
      return f ? { status: 'ok', text: readFixture(f), etag: null, lastModified: null, finalUrl: u } : { status: 'error', code: 'http-404' };
    },
    publisher: {
      publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))),
      rsvps: async () => new Set(), fetchOwn: async () => [], pendingFor: () => 0,
      ...(options.pending ? { pending: options.pending } : {}),
      close: () => {},
    },
    log: (line) => log.push(line),
  });
  for (const f of FIXTURES) {
    const id = identify(feedUrlFor(f));
    if (!dir.get(id.d)) dir.add({ ...id, name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'maintainer', addedAt: NOW - 86400 });
  }
  const admin = { db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db) };
  return { dir, sent, log, indexer, admin, indexPubkey: getPublicKey(s.indexKey) };
}

// Calendar keys made and used before the pause, as live.
async function withKeys() {
  const s = stores();
  await service(s, {}).indexer.tick();
  const keys = s.vault.keys();
  assert.equal(keys.length, 2);
  return { s, keys };
}

const KINDS = [31922, 31923, 31924, 10002];

test('once asked, every calendar key signs its retired profile and deletions of everything it signed, sent to our relay, the search, general and profile relays, never the list relays', async () => {
  const { s, keys } = await withKeys();
  const live = service(s, LIVE);
  await live.indexer.tick();
  assert.ok(!live.sent.some((x) => x.event.pubkey !== live.indexPubkey && x.event.kind !== 5), 'nothing but deletions before it is asked');
  live.sent.length = 0;

  assert.match(retireCalendarKeys(live.admin, NOW), /asked/);
  await live.indexer.tick();
  for (const { pubkey } of keys) {
    const by = live.sent.filter((x) => x.event.pubkey === pubkey);
    assert.deepEqual([...new Set(by.map((x) => x.audience))].sort(), ['general', 'own', 'profiles', 'search']);
    for (const audience of ['own', 'search', 'general', 'profiles'] as Audience[]) {
      const events = by.filter((x) => x.audience === audience).map((x) => x.event);
      assert.ok(events.every(verifyEvent));
      const profile = events.find((e) => e.kind === 0)!;
      assert.equal(JSON.parse(profile.content).name, 'Retired Event Index mirror');
      const deletions = events.filter((e) => e.kind === 5);
      const named = new Set(deletions.flatMap((e) => e.tags.filter((t) => t[0] === 'a').map((t) => t[1])));
      const ids = new Set(deletions.flatMap((e) => e.tags.filter((t) => t[0] === 'e').map((t) => t[1])));
      for (const a of s.db.signedAddresses(pubkey, KINDS)) {
        assert.ok(named.has(`${a.kind}:${pubkey}:${a.d}`), `${audience}: ${a.kind}:${a.d}`);
        for (const v of a.versions) assert.ok(ids.has(v));
      }
      assert.ok(s.db.signedAddresses(pubkey, KINDS).some((a) => a.kind === 10002), 'its relay list too');
      // Newer than everything it deletes, and than its last profile.
      const newest = Math.max(0, ...s.db.signedAddresses(pubkey, [0, ...KINDS]).map((a) => s.db.lastCreatedAt(pubkey, a.kind, a.d) ?? 0));
      assert.ok(newest > 0);
      assert.ok(events.every((e) => e.created_at > newest), `${events.map((e) => e.created_at)} vs ${newest}`);
    }
  }
  assert.equal(s.vault.keys().length, 2, 'no key material is destroyed');
  assert.ok(live.log.some((l) => /calendar keys: \d+ retirement events signed for 2 keys/.test(l)), live.log.join('\n'));
});

test('the retirement is signed once and sent again after a restart until the outside relays took it; then the follow list is empty', async () => {
  const { s, keys } = await withKeys();
  let queued = 9;
  const first = service(s, LIVE, { pending: () => queued });
  retireCalendarKeys(first.admin, NOW);
  await first.indexer.tick();
  const signed = retirementStore(s.db).all().map((e) => e.id).sort();
  const sentFirst = first.sent.filter((x) => x.event.pubkey !== first.indexPubkey && x.audience === 'search').map((x) => x.event.id).sort();
  assert.deepEqual(sentFirst, signed);

  const restarted = service(s, LIVE, { pending: () => queued, at: NOW + 60 });
  await restarted.indexer.tick();
  assert.deepEqual(retirementStore(s.db).all().map((e) => e.id).sort(), signed, 'signed once');
  assert.deepEqual(restarted.sent.filter((x) => x.event.pubkey !== restarted.indexPubkey && x.audience === 'search').map((x) => x.event.id).sort(), signed, 'sent again in full');
  await restarted.indexer.tick();
  assert.equal(restarted.sent.filter((x) => x.event.pubkey !== restarted.indexPubkey && x.audience === 'search').length, signed.length, 'once per run');

  queued = 0;
  await restarted.indexer.tick();
  assert.ok(restarted.log.some((l) => l.includes('calendar keys: retirement sent')), restarted.log.join('\n'));
  // The follow list, published again at the next tick, follows no one.
  restarted.sent.length = 0;
  await restarted.indexer.tick();
  const follows = restarted.sent.filter((x) => x.event.kind === 3 && x.event.pubkey === restarted.indexPubkey).map((x) => x.event);
  assert.ok(follows.length > 0, 'published again');
  assert.ok(follows.every((e) => e.tags.length === 0), JSON.stringify(follows.map((e) => e.tags)));
  const after = service(s, LIVE, { at: NOW + 180 });
  await after.indexer.tick();
  assert.equal(after.sent.filter((x) => x.event.pubkey !== after.indexPubkey).length, 0, 'not sent after it is done');
  for (const { pubkey } of keys) assert.ok(!after.sent.some((x) => x.event.tags.some((t) => t[0] === 'p' && t[1] === pubkey)));
});

test('destroying the keys is refused until the retirement is sent; then every key is gone, the directory names none, and the relay allows none', async () => {
  const { s, keys } = await withKeys();
  let queued = 3;
  const live = service(s, LIVE, { pending: () => queued });
  assert.match(destroyCalendarKeys(live.admin, NOW), /not yet/);
  retireCalendarKeys(live.admin, NOW);
  await live.indexer.tick();
  assert.match(destroyCalendarKeys(live.admin, NOW), /not yet/);
  queued = 0;
  await live.indexer.tick();
  assert.match(destroyCalendarKeys(live.admin, NOW), /asked/);
  await live.indexer.tick();

  assert.deepEqual(s.vault.keys(), []);
  for (const f of FIXTURES) assert.equal(live.dir.get(identify(feedUrlFor(f)).d)!.pubkey, null);
  const allow = JSON.parse(readFileSync(s.allowlist, 'utf8')) as Record<string, string[]>;
  for (const { pubkey } of keys) assert.ok(!JSON.stringify(allow).includes(pubkey), 'the relay allows it no more');
  // What was signed is kept, for the recount.
  assert.deepEqual([...new Set(retirementStore(s.db).all().map((e) => e.pubkey))].sort(), keys.map((k) => k.pubkey).sort());
  assert.ok(live.log.some((l) => /calendar keys: 2 destroyed/.test(l)), live.log.join('\n'));
  // A calendar polled after it has no key, and gets none.
  await service(s, LIVE, { at: NOW + 7200 }).indexer.tick();
  assert.deepEqual(s.vault.keys(), []);
});
