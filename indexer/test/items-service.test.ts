import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
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
  EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER,
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
  // Nothing is signed but by the index key.
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

test('after a restart, a calendar polled alone still yields its copy to the other calendar, known from its stored records', async () => {
  const s = stores();
  const shared = readFixture(FIXTURES[0]!).split(/(?=^BEGIN:VEVENT$)/m).find((b) => b.includes('SUMMARY:craftyween party'))!.replace(/END:VCALENDAR\s*$/, '');
  const cohosting = readFixture(FIXTURES[1]!).replace(/END:VCALENDAR\s*$/, `${shared}END:VCALENDAR\n`);
  const first = service(s, ITEMS, { texts: { [FIXTURES[1]!]: cohosting } });
  await first.indexer.tick();
  for (const f of FIXTURES) pollAgain(s, identify(feedUrlFor(f)).d);
  await first.indexer.tick();
  const copiesBefore = FIXTURES.flatMap((f) => first.events.byCalendar(identify(feedUrlFor(f)).d, NOW, NOW + 400 * 86400)).filter((r) => r.canonical).map((r) => [r.id, r.canonical]);
  assert.ok(copiesBefore.length > 0);

  // A restart; then only the co-hosting calendar is polled.
  const second = service(s, ITEMS, { texts: { [FIXTURES[1]!]: cohosting }, at: NOW + 60 });
  pollAgain(s, identify(feedUrlFor(FIXTURES[1]!)).d);
  await second.indexer.tick();
  const copiesAfter = FIXTURES.flatMap((f) => second.events.byCalendar(identify(feedUrlFor(f)).d, NOW, NOW + 400 * 86400)).filter((r) => r.canonical).map((r) => [r.id, r.canonical]);
  assert.deepEqual(copiesAfter, copiesBefore);
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

const entryOf = (sent: Array<{ audience: Audience; event: VerifiedEvent }>, indexPubkey: string, d: string) =>
  sent.filter((x) => x.audience === 'own' && x.event.pubkey === indexPubkey && x.event.kind === 39999 && tag(x.event, 'd') === d && !isItem(x.event)).at(-1)?.event;

test('a calendar\'s entry names no key until its organizer verifies one, and it is listed all the same', async () => {
  const svc = service(stores(), ITEMS);
  await svc.indexer.tick();
  const entry = entryOf(svc.sent, svc.indexPubkey, D)!;
  assert.ok(entry, 'listed');
  assert.deepEqual(entry.tags.filter((t) => t[0] === 'p'), []);
});

test('an organizer who verified their key is the p of their calendar\'s entry and of its items', async () => {
  const s = stores();
  const svc = service(s, ITEMS);
  const owner = 'ee'.repeat(32);
  svc.dir.setOwnership(D, { mode: 'mirrored', owner, claimedAt: NOW, nativeCalendar: null });
  await svc.indexer.tick();
  assert.deepEqual(entryOf(svc.sent, svc.indexPubkey, D)!.tags.filter((t) => t[0] === 'p'), [['p', owner]]);
  const items = svc.sent.filter((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'calendar')!.endsWith(`:${D}`));
  assert.ok(items.length > 0 && items.every((x) => tag(x.event, 'p') === owner));
});

test('with event items on, a record names its event\'s item as its nostr address', async () => {
  const s = stores();
  const svc = service(s, ITEMS);
  await svc.indexer.tick();
  const item = svc.sent.find((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'calendar')!.endsWith(`:${D}`))!.event;
  // The calendar's next full read writes it into the record.
  pollAgain(s, D);
  await service(s, ITEMS, { at: NOW + 60 }).indexer.tick();
  const record = s.db.record(tag(item, 'd')!)!;
  const naddr = naddrEncode({ kind: 39999, pubkey: svc.indexPubkey, identifier: tag(item, 'd')!, relays: ['wss://relay.eventindex.space'] });
  assert.match(record.ics.replace(/\r\n /g, ''), new RegExp(`X-EVENTINDEX-NOSTR:${naddr}`));
});

test('with a cap on items, no more than so many are live; those keep being updated and withdrawn', async () => {
  const s = stores();
  const svc = service(s, { ...ITEMS, EVENTINDEX_EVENT_ITEMS_MAX: '2' });
  await svc.indexer.tick();
  const first = svc.sent.filter((x) => isItem(x.event) && x.audience === 'own').map((x) => x.event);
  assert.equal(first.length, 2);
  // A later pass adds none, the cap being reached.
  const later = service(s, { ...ITEMS, EVENTINDEX_EVENT_ITEMS_MAX: '2' }, { at: NOW + 3600 });
  await later.indexer.tick();
  const added = later.sent.filter((x) => isItem(x.event) && x.audience === 'own' && !first.some((f) => tag(f, 'd') === tag(x.event, 'd')));
  assert.equal(added.length, 0);
  assert.throws(() => loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_MAX: 'many' }), /EVENTINDEX_EVENT_ITEMS_MAX/);
});

test('an event in UTC takes its venue\'s zone, a hidden venue\'s too, whose coordinates are kept nowhere', async () => {
  const s = stores();
  // The calendar's city is New York; this event is in Stockholm, its venue shown only to guests.
  const hidden = readFixture(FIXTURES[0]!)
    .replace('LOCATION:haricot vert\'s dreamworld, 119 N 1st St, Brooklyn, NY 11249, USA\nGEO:40.7155365;-73.9619548\nSEQUENCE:214250816\nSTATUS:TENTATIVE\nEND:VEVENT\nEND:VCALENDAR',
      'LOCATION:https://luma.com/event/evt-PDzqdd9OU1nQXYz\nGEO:59.3293;18.0686\nSEQUENCE:214250816\nSTATUS:TENTATIVE\nEND:VEVENT\nEND:VCALENDAR');
  assert.notEqual(hidden, readFixture(FIXTURES[0]!));
  const svc = service(s, ITEMS, { texts: { [FIXTURES[0]!]: hidden } });
  await svc.indexer.tick();
  const row = svc.events.byCalendar(D, NOW, NOW + 400 * 86400).find((r) => r.title === 'craftyween party')!;
  assert.equal(row.tzid, 'Europe/Stockholm');
  assert.equal(row.g, null);
  const item = svc.sent.find((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'd') === row.id)!.event;
  assert.equal(tag(item, 'start_tzid'), 'Europe/Stockholm');
  assert.equal(tag(item, 'when'), 'Sat 24 Oct 2026, 6:00 PM-10:00 PM CEST');
  assert.equal(tag(item, 'g'), undefined);
  assert.doesNotMatch(s.db.record(row.recordId)!.ics, /59\.3|18\.06/);
  assert.ok(!JSON.stringify(item).includes('59.3'));
  // A shown venue in UTC is written in its own zone too: Brooklyn's.
  const shown = svc.sent.find((x) => isItem(x.event) && x.audience === 'own' && tag(x.event, 'title') !== 'craftyween party' && tag(x.event, 'g'))!.event;
  assert.equal(tag(shown, 'start_tzid'), 'America/New_York');
});

// A list of the calendars whose events are items, as the operator keeps it.
function calendarList(calendars: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'items-')), 'item-calendars.json');
  writeFileSync(file, JSON.stringify({ description: 'Calendars listed as items.', calendars }));
  return file;
}

test('with a list of calendars, only theirs are items; a calendar taken off it has its items withdrawn at once', async () => {
  const s = stores();
  const other = identify(feedUrlFor(FIXTURES[1]!)).d;
  const svc = service(s, { ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: calendarList([{ d: other, name: 'Journaling' }]) });
  await svc.indexer.tick();
  const first = svc.sent.filter((x) => isItem(x.event) && x.audience === 'own').map((x) => x.event);
  assert.ok(first.length > 0);
  assert.ok(first.every((e) => tag(e, 'calendar')!.endsWith(`:${other}`)), 'only the listed calendar\'s events');
  // Its entry and the other calendar's are both still listed in the directory.
  const entries = svc.sent.filter((x) => x.event.kind === 39999 && x.audience === 'own' && !isItem(x.event)).map((x) => tag(x.event, 'd'));
  assert.ok(entries.includes(D) && entries.includes(other));

  // The list now names the other calendar only, as a plain d.
  const later = service(s, { ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: calendarList([D]) }, { at: NOW + 3600 });
  await later.indexer.tick();
  const deletions = later.sent.filter((x) => x.audience === 'own' && x.event.kind === 5 && x.event.tags.some((t) => t[0] === 'k' && t[1] === '39999'));
  const withdrawn = new Set(deletions.flatMap((x) => x.event.tags.filter((t) => t[0] === 'a').map((t) => t[1]!.split(':')[2])));
  assert.deepEqual([...withdrawn].sort(), first.map((e) => tag(e, 'd')!).sort());
  const added = later.sent.filter((x) => isItem(x.event) && x.audience === 'own');
  assert.ok(added.length > 0 && added.every((x) => tag(x.event, 'calendar')!.endsWith(`:${D}`)));
});

test('a list of calendars that cannot be read, or is not a list, stops the service from starting', () => {
  assert.throws(() => loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: '/nonexistent/item-calendars.json' }), /EVENTINDEX_EVENT_ITEMS_CALENDARS/);
  assert.throws(() => loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: calendarList('luma:cal-x') }), /EVENTINDEX_EVENT_ITEMS_CALENDARS/);
  assert.throws(() => loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: calendarList([{ name: 'no d' }]) }), /EVENTINDEX_EVENT_ITEMS_CALENDARS/);
  assert.equal(loadSettings(ITEMS).eventItemsCalendars, null);
  assert.deepEqual([...loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: calendarList(['meetup:a', { d: 'luma:cal-b' }]) }).eventItemsCalendars!], ['meetup:a', 'luma:cal-b']);
});

test('the calendars listed in seeds/item-calendars.json load by their path in the repository', () => {
  const calendars = loadSettings({ ...ITEMS, EVENTINDEX_EVENT_ITEMS_CALENDARS: 'seeds/item-calendars.json' }).eventItemsCalendars!;
  assert.ok(calendars.size > 0);
  for (const d of calendars) assert.match(d, /^(luma:cal-[A-Za-z0-9]+|meetup:[a-z0-9-]+)$/);
});
