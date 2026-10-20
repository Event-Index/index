import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb, type IndexDb } from '../src/store/index-db.ts';
import { openVault, type Vault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { relayPauses } from '../src/service/publisher.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { NOW } from './helpers.ts';

const HEADER = `39998:${'ab'.repeat(32)}:events`;
const LISTS = 'wss://lists.test';
const ENV = {
  EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER,
  EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE: '1',
  EVENTINDEX_SEARCH_RELAYS: 'wss://search.test', EVENTINDEX_LIST_RELAYS: LISTS, EVENTINDEX_GENERAL_RELAYS: 'wss://general.test',
  EVENTINDEX_PROFILE_RELAYS: 'none',
};
const FEED_URL = 'https://fixture.eventindex.space/synthetic/expiry.ics';
const FEED = identify(FEED_URL);
const DAY = 86400;
const EXPIRE = 30 * DAY;

const stamp = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
interface Ev { uid: string; title: string; start: number; end: number }
const feed = (events: Ev[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Event Index//fixture//EN\r\nX-WR-CALNAME:Expiry Club\r\n${events.map((e) =>
  `BEGIN:VEVENT\r\nUID:${e.uid}\r\nDTSTART:${stamp(e.start)}\r\nDTEND:${stamp(e.end)}\r\nSUMMARY:${e.title}\r\nLOCATION:Example Hall\\, Austin\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
const A: Ev = { uid: 'a@expiry', title: 'Soon', start: NOW + 3600, end: NOW + 7200 };
const B: Ev = { uid: 'b@expiry', title: 'Later', start: NOW + 200 * DAY, end: NOW + 200 * DAY + 3600 };

interface Stores { db: IndexDb; vault: Vault; indexKey: Uint8Array }
const stores = (): Stores => ({ db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey() });

function service(s: Stores, text: { feed: string }, options: { at?: number; pending?: () => number } = {}) {
  const dir = directoryStore(s.db);
  const sent: Array<{ audience: Audience; relays?: string[]; event: VerifiedEvent }> = [];
  const clock = { now: options.at ?? NOW };
  const indexer = createIndexer({
    db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...ENV }),
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => (url === FEED.feedUrl ? { status: 'ok', text: text.feed, etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' }),
    publisher: {
      publish: async (list, audience, relays) => void sent.push(...list.map((event) => ({ audience, ...(relays ? { relays } : {}), event }))),
      pendingFor: () => options.pending?.() ?? 0,
      rsvps: async () => new Set(), close: () => {},
    },
    log: () => {},
  });
  if (!dir.get(FEED.d)) dir.add({ ...FEED, name: null, description: null, image: null, location: 'Austin, US', g: '9v6k', foundVia: 'maintainer', addedAt: NOW - DAY });
  return { dir, sent, clock, indexer, indexPubkey: getPublicKey(s.indexKey), events: eventStore(s.db) };
}

const pollAgain = (s: Stores) => s.db.savePollState(FEED.d, { ...s.db.pollState(FEED.d), nextPollAt: 0, etag: null, lastModified: null });
const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === HEADER);
const tag = (e: VerifiedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const itemId = (svc: ReturnType<typeof service>, uid: string) => svc.events.byCalendar(FEED.d, 0, NOW + 400 * DAY).find((r) => r.uid === uid)!.id;
const ownItems = (svc: ReturnType<typeof service>, d: string) => svc.sent.filter((x) => x.audience === 'own' && isItem(x.event) && tag(x.event, 'd') === d).map((x) => x.event);
const deletions = (svc: ReturnType<typeof service>) => svc.sent.filter((x) => x.event.kind === 5 && x.event.tags.some((t) => t[0] === 'k' && t[1] === '39999'));

test('an item past its expiration is deleted from the list relay alone, once, naming every version; an unexpired item is untouched', async () => {
  const s = stores();
  const text = { feed: feed([A, B]) };
  const svc = service(s, text);
  await svc.indexer.tick();
  const a = itemId(svc, A.uid);
  const b = itemId(svc, B.uid);
  text.feed = feed([{ ...A, title: 'Soon, moved rooms' }, B]);
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  const versions = ownItems(svc, a).map((e) => e.id);
  assert.equal(versions.length, 2, 'two versions of the item');
  assert.equal(tag(ownItems(svc, a).at(-1)!, 'expiration'), String(A.end + EXPIRE));

  // Ended, not yet expired: nothing.
  svc.clock.now = A.end + 10 * DAY;
  await svc.indexer.tick();
  assert.equal(deletions(svc).length, 0);

  svc.clock.now = A.end + EXPIRE + 60;
  await svc.indexer.tick();
  const sent = deletions(svc);
  assert.equal(sent.length, 1, 'exactly one deletion');
  assert.equal(sent[0]!.audience, 'lists');
  const deletion = sent[0]!.event;
  assert.ok(verifyEvent(deletion));
  assert.equal(deletion.pubkey, svc.indexPubkey);
  assert.deepEqual(deletion.tags.filter((t) => t[0] === 'e').map((t) => t[1]).sort(), [...versions].sort());
  assert.deepEqual(deletion.tags.filter((t) => t[0] === 'a').map((t) => t[1]), [`39999:${svc.indexPubkey}:${a}`]);
  assert.deepEqual(deletion.tags.filter((t) => t[0] === 'k'), [['k', '39999']]);
  assert.ok(deletion.created_at <= svc.clock.now);
  assert.ok(!svc.sent.some((x) => x.event.kind === 5 && x.audience !== 'lists'), 'our relay and the search relay are left to NIP-40');
  assert.equal(s.db.projection(svc.indexPubkey, 39999, a)!.status, 'expired');

  const before = svc.sent.length;
  for (let i = 0; i < 3; i += 1) {
    svc.clock.now += 700;
    pollAgain(s);
    await svc.indexer.tick();
  }
  assert.equal(deletions(svc).length, 1, 'never sent again');
  assert.equal(ownItems(svc, a).length, 2, 'never republished');
  assert.ok(!svc.sent.slice(before).some((x) => tag(x.event, 'd') === b), 'the unexpired item is untouched');
  assert.equal(s.db.projection(svc.indexPubkey, 39999, b)!.status, 'live');
});

test('items expiring together share deletions of at most 200 tags, an item never split between two', async () => {
  const s = stores();
  const many = Array.from({ length: 150 }, (_, i) => ({ uid: `m${i}@expiry`, title: `Talk ${i}`, start: NOW + 3600, end: NOW + 7200 + i }));
  const text = { feed: feed(many) };
  const svc = service(s, text);
  await svc.indexer.tick();
  svc.clock.now = NOW + 7200 + 150 + EXPIRE + 60;
  await svc.indexer.tick();
  const sent = deletions(svc).map((x) => x.event);
  assert.ok(sent.length >= 2 && sent.length < 150, `${sent.length} deletions`);
  assert.ok(sent.every((e) => e.tags.length <= 200));
  const addresses = sent.flatMap((e) => e.tags.filter((t) => t[0] === 'a').map((t) => t[1]!));
  assert.equal(new Set(addresses).size, 150);
  for (const e of sent) {
    for (const [, address] of e.tags.filter((t) => t[0] === 'a')) {
      const d = address!.split(':')[2]!;
      const versions = s.db.versions(svc.indexPubkey, 39999, d);
      assert.ok(versions.every((v) => e.tags.some((t) => t[0] === 'e' && t[1] === v)), 'an item\'s versions travel with its address');
    }
  }
  assert.equal(new Set(sent.map((e) => e.created_at)).size, sent.length, 'created_at spread');
});

test('a deletion the list relay has not taken yet is sent again after a restart, until it has', async () => {
  const s = stores();
  const text = { feed: feed([A, B]) };
  let pending = 1;
  const first = service(s, text, { pending: () => pending });
  await first.indexer.tick();
  first.clock.now = A.end + EXPIRE + 60;
  await first.indexer.tick();
  first.clock.now += 60;
  await first.indexer.tick();
  assert.equal(deletions(first).length, 1, 'queued once while it waits');
  const id = deletions(first)[0]!.event.id;

  const second = service(s, text, { at: first.clock.now + 60, pending: () => pending });
  await second.indexer.tick();
  assert.deepEqual(deletions(second).map((x) => x.event.id), [id], 'the same deletion again after a restart');
  // Left off by the relay, which drops what was waiting for it: nothing is
  // sent and nothing counts as taken, whatever its queue says.
  relayPauses(second.dir).set(LISTS, { until: null, strikes: 2 });
  pending = 0;
  second.clock.now += 60;
  await second.indexer.tick();
  const third = service(s, text, { at: second.clock.now + 60, pending: () => pending });
  await third.indexer.tick();
  assert.equal(deletions(second).length, 1);
  assert.equal(deletions(third).length, 0, 'nothing while the relay is left off');

  relayPauses(third.dir).set(LISTS, null);
  third.clock.now += 60;
  await third.indexer.tick();
  assert.deepEqual(deletions(third).map((x) => x.event.id), [id], 'still owed, sent once the relay is back');
  third.clock.now += 60;
  await third.indexer.tick();
  const fourth = service(s, text, { at: third.clock.now + 60, pending: () => pending });
  await fourth.indexer.tick();
  assert.equal(deletions(fourth).length, 0, 'drained: not sent again');
});

test('a later edit to a past event brings nothing back; one that moves it ahead gives it a new item, deleted in its turn', async () => {
  const s = stores();
  const text = { feed: feed([A, B]) };
  const svc = service(s, text);
  await svc.indexer.tick();
  const a = itemId(svc, A.uid);
  svc.clock.now = A.end + EXPIRE + 60;
  await svc.indexer.tick();
  const deletedAt = deletions(svc)[0]!.event.created_at;

  text.feed = feed([{ ...A, title: 'Soon (recording posted)' }, B]);
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  assert.equal(ownItems(svc, a).length, 1, 'an edit to the past event republishes nothing');
  assert.equal(deletions(svc).length, 1);

  const moved = { ...A, start: svc.clock.now + 10 * DAY, end: svc.clock.now + 10 * DAY + 3600 };
  text.feed = feed([moved, B]);
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  const back = ownItems(svc, a);
  assert.equal(back.length, 2, 'upcoming again: a new version');
  assert.ok(back.at(-1)!.created_at > deletedAt, 'later than the deletion, so the list relay takes it');
  assert.equal(s.db.projection(svc.indexPubkey, 39999, a)!.status, 'live');

  svc.clock.now = moved.end + EXPIRE + 60;
  await svc.indexer.tick();
  assert.equal(deletions(svc).length, 2, 'expired again, deleted again');
  assert.ok(deletions(svc)[1]!.event.tags.some((t) => t[0] === 'e' && t[1] === back.at(-1)!.id));
});
