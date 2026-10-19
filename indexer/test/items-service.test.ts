import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb, type IndexDb } from '../src/store/index-db.ts';
import { openVault, type Vault } from '../src/store/vault-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { createIndexer, type Audience } from '../src/service/indexer.ts';
import { loadSettings } from '../src/config.ts';
import { identify } from '../src/directory/id.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const HEADER = `39998:${'ab'.repeat(32)}:events`;
const FIXTURES = ['luma-calendar-craftnook.ics', 'luma-calendar-journaling.ics'];
const D = identify(feedUrlFor(FIXTURES[0]!)).d;
const ITEMS = {
  EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER, EVENTINDEX_CALENDAR_KEYS_PAUSED: '1',
  EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE: '1',
  EVENTINDEX_SEARCH_RELAYS: 'wss://search.test', EVENTINDEX_LIST_RELAYS: 'wss://lists.test', EVENTINDEX_GENERAL_RELAYS: 'wss://general.test',
};

interface Stores { db: IndexDb; vault: Vault; indexKey: Uint8Array }
const stores = (): Stores => ({ db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey() });

function service(s: Stores, env: Record<string, string>, options: { texts?: Record<string, string>; at?: number; itemsPerTick?: number; itemsPerSecond?: number } = {}) {
  const dir = directoryStore(s.db);
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const urls = new Map(FIXTURES.map((f) => [identify(feedUrlFor(f)).feedUrl, f]));
  const clock = { now: options.at ?? NOW };
  const indexer = createIndexer({
    db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...env }),
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => {
      const f = urls.get(url);
      return f ? { status: 'ok', text: options.texts?.[f] ?? readFixture(f), etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' };
    },
    publisher: { publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))), rsvps: async () => new Set(), close: () => {} },
    log: () => {},
    ...(options.itemsPerTick ? { itemsPerTick: options.itemsPerTick } : {}),
    ...(options.itemsPerSecond ? { itemsPerSecond: options.itemsPerSecond } : {}),
  });
  for (const f of FIXTURES) {
    const id = identify(feedUrlFor(f));
    if (!dir.get(id.d)) dir.add({ ...id, name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'maintainer', addedAt: NOW - 86400 });
  }
  return { dir, sent, clock, indexer, indexPubkey: getPublicKey(s.indexKey), queues: queueStore(s.db), events: eventStore(s.db) };
}

const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === HEADER);
const tag = (e: VerifiedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const pollAgain = (s: Stores, d: string) => s.db.savePollState(d, { ...s.db.pollState(d), nextPollAt: 0, etag: null, lastModified: null });

test('with event items on, each upcoming event of a mirrored calendar is an item, signed by the index key, on our relay, the list relay and the search relay only', async () => {
  const s = stores();
  const svc = service(s, ITEMS);
  await svc.indexer.tick();
  const items = svc.sent.filter((x) => isItem(x.event));
  assert.ok(items.length > 0);
  assert.ok(items.every((x) => x.event.pubkey === svc.indexPubkey && verifyEvent(x.event)));
  assert.deepEqual([...new Set(items.map((x) => x.audience))].sort(), ['lists', 'own', 'search']);
  // One item per upcoming event that is not a copy, in both calendars.
  const upcoming = [...FIXTURES.map((f) => identify(feedUrlFor(f)).d)].flatMap((d) => svc.events.byCalendar(d, NOW, NOW + 400 * 86400))
    .filter((r) => !r.canonical && (r.end ?? r.start) >= NOW);
  const own = items.filter((x) => x.audience === 'own').map((x) => tag(x.event, 'd')!).sort();
  assert.deepEqual(own, upcoming.map((r) => r.id).sort());
  // Calendar keys are paused, and sign nothing.
  assert.ok(!svc.sent.some((x) => x.event.pubkey !== svc.indexPubkey));
});

test('a copy of another calendar\'s event is not an item; the original is', async () => {
  const s = stores();
  // The second calendar co-hosts one of the first's events: the same Luma event in both feeds.
  const shared = readFixture(FIXTURES[0]!).split(/(?=^BEGIN:VEVENT$)/m).find((b) => b.includes('SUMMARY:craftyween party'))!.replace(/END:VCALENDAR\s*$/, '');
  const cohosting = readFixture(FIXTURES[1]!).replace(/END:VCALENDAR\s*$/, `${shared}END:VCALENDAR\n`);
  const svc = service(s, ITEMS, { texts: { [FIXTURES[1]!]: cohosting } });
  await svc.indexer.tick();
  // Both are polled knowing each other's events at the next tick, as the service does after a cycle.
  for (const f of FIXTURES) pollAgain(s, identify(feedUrlFor(f)).d);
  await svc.indexer.tick();
  const copies = FIXTURES.flatMap((f) => svc.events.byCalendar(identify(feedUrlFor(f)).d, NOW, NOW + 400 * 86400)).filter((r) => r.canonical);
  const ids = new Set(svc.sent.filter((x) => isItem(x.event)).map((x) => tag(x.event, 'd')));
  for (const copy of copies) assert.ok(!ids.has(copy.id), copy.title);
  assert.ok(copies.length > 0, 'the two calendars co-host an event');
  const originals = copies.map((c) => c.canonical!);
  for (const id of originals) assert.ok(ids.has(id), 'the original is an item');
});

test('an unchanged item is not sent again; a changed one is, newer', async () => {
  const s = stores();
  const first = service(s, ITEMS);
  await first.indexer.tick();
  const before = first.sent.filter((x) => isItem(x.event) && x.audience === 'own').map((x) => x.event);
  await first.indexer.tick();
  assert.equal(first.sent.filter((x) => isItem(x.event) && x.audience === 'own').length, before.length, 'nothing new');

  pollAgain(s, D);
  const moved = readFixture(FIXTURES[0]!).replace('SUMMARY:craftyween party', 'SUMMARY:craftyween party (moved upstairs)');
  const second = service(s, ITEMS, { texts: { [FIXTURES[0]!]: moved }, at: NOW + 60 });
  await second.indexer.tick();
  const changed = second.sent.filter((x) => isItem(x.event) && x.audience === 'own').map((x) => x.event);
  assert.equal(changed.length, 1);
  assert.equal(tag(changed[0]!, 'title'), 'craftyween party (moved upstairs)');
  const old = before.find((e) => tag(e, 'd') === tag(changed[0]!, 'd'))!;
  assert.ok(changed[0]!.created_at > old.created_at);
});

test('an item whose event left its feed is withdrawn a day later, naming every version, its address and kind', async () => {
  const s = stores();
  const first = service(s, ITEMS);
  await first.indexer.tick();
  const plushie = first.sent.find((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'title')!.includes('plushie'))!.event;
  const gone = readFixture(FIXTURES[0]!).split(/(?=^BEGIN:VEVENT$)/m).find((b) => b.includes('SUMMARY:precious plushie taxidermy'))!;
  const text = readFixture(FIXTURES[0]!).replace(gone.replace(/END:VCALENDAR\s*$/, ''), '');
  let deletion: VerifiedEvent | undefined;
  for (const at of [NOW + 3600, NOW + 13 * 3600]) {
    pollAgain(s, D);
    const svc = service(s, ITEMS, { texts: { [FIXTURES[0]!]: text }, at });
    await svc.indexer.tick();
    assert.ok(!svc.sent.some((x) => x.event.kind === 5), 'not before a day has passed');
  }
  pollAgain(s, D);
  const later = service(s, ITEMS, { texts: { [FIXTURES[0]!]: text }, at: NOW + 25 * 3600 });
  await later.indexer.tick();
  deletion = later.sent.find((x) => x.event.kind === 5 && x.audience === 'own')?.event;
  assert.ok(deletion);
  assert.deepEqual(deletion.tags, [['e', plushie.id], ['a', `39999:${later.indexPubkey}:${tag(plushie, 'd')}`], ['k', '39999']]);
  assert.deepEqual([...new Set(later.sent.filter((x) => x.event.kind === 5).map((x) => x.audience))].sort(), ['lists', 'own', 'search']);
});

test('a removed calendar\'s upcoming items are withdrawn at its removal', async () => {
  const s = stores();
  const first = service(s, ITEMS);
  await first.indexer.tick();
  const live = first.sent.filter((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'calendar')!.endsWith(`:${D}`));
  assert.ok(live.length > 0);
  const svc = service(s, ITEMS, { at: NOW + 60 });
  const { id } = svc.queues.requestRemoval({ d: D, message: null, at: NOW + 60 });
  svc.queues.resolveRemoval(id, 'approved', NOW + 60);
  await svc.indexer.tick();
  const withdrawn = svc.sent.filter((x) => x.audience === 'own' && x.event.kind === 5 && x.event.pubkey === svc.indexPubkey).map((x) => tag(x.event, 'a')!.split(':')[2]);
  assert.deepEqual(withdrawn.sort(), live.map((x) => tag(x.event, 'd')!).sort());
});

test('items are signed a batch a tick, with created_at spread', async () => {
  const s = stores();
  const svc = service(s, ITEMS, { itemsPerTick: 2, itemsPerSecond: 1 });
  await svc.indexer.tick();
  const first = svc.sent.filter((x) => isItem(x.event) && x.audience === 'own').map((x) => x.event);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((e) => e.created_at).sort(), [NOW - 1, NOW]);
  await svc.indexer.tick();
  assert.equal(svc.sent.filter((x) => isItem(x.event) && x.audience === 'own').length, 4, 'the rest follow at the next ticks');
});

test('with event items off, nothing is an item', async () => {
  const s = stores();
  const svc = service(s, { EVENTINDEX_EVENTS_HEADER: HEADER });
  await svc.indexer.tick();
  assert.ok(!svc.sent.some((x) => isItem(x.event)));
});
