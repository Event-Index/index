import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
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
const SEARCH = 'wss://search.test';
const ENV = {
  EVENTINDEX_EVENT_ITEMS: '1', EVENTINDEX_EVENTS_HEADER: HEADER,
  EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE: '1',
  EVENTINDEX_SEARCH_RELAYS: SEARCH, EVENTINDEX_LIST_RELAYS: LISTS, EVENTINDEX_GENERAL_RELAYS: 'wss://general.test',
  EVENTINDEX_PROFILE_RELAYS: 'none',
};
const FEED = identify('https://fixture.eventindex.space/synthetic/reconcile.ics');
const DAY = 86400;

const stamp = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
interface Ev { uid: string; title: string; start: number }
const feed = (events: Ev[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Event Index//fixture//EN\r\nX-WR-CALNAME:Reconcile Club\r\n${events.map((e) =>
  `BEGIN:VEVENT\r\nUID:${e.uid}\r\nDTSTART:${stamp(e.start)}\r\nDTEND:${stamp(e.start + 3600)}\r\nSUMMARY:${e.title}\r\nLOCATION:Example Hall\\, Austin\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
const A: Ev = { uid: 'a@reconcile', title: 'First', start: NOW + 5 * DAY };
const B: Ev = { uid: 'b@reconcile', title: 'Second', start: NOW + 9 * DAY };

interface Stores { db: IndexDb; vault: Vault; indexKey: Uint8Array }
const stores = (): Stores => ({ db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey() });

const dOf = (e: VerifiedEvent) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
const isItem = (e: VerifiedEvent) => e.kind === 39999 && e.tags.some((t) => t[0] === 'z' && t[1] === HEADER);

// Relays that keep the newest version of each item they were sent. A relay
// can lose the next version it is sent of an item (by title), answer short
// or not at all.
function relays() {
  const held = new Map<string, Map<string, VerifiedEvent>>();
  const lose = new Map<string, Set<string>>();
  const asked: Array<{ relay: string; ids: string[] }> = [];
  const answer: { short?: (relay: string, ask: number) => Set<string> | null; none?: Set<string> } = {};
  const keep = (relay: string, e: VerifiedEvent) => {
    if (lose.get(relay)?.delete(e.tags.find((t) => t[0] === 'title')?.[1] ?? '')) return;
    const store = held.get(relay) ?? new Map<string, VerifiedEvent>();
    const had = store.get(dOf(e));
    if (!had || had.created_at < e.created_at) store.set(dOf(e), e);
    held.set(relay, store);
  };
  const read = (relay: string, filter: Filter) => {
    const ids = filter['#d'] ?? [];
    return ids.map((d) => held.get(relay)?.get(d)).filter((e): e is VerifiedEvent => !!e && e.kind === 39999);
  };
  return { held, lose, asked, answer, keep, read };
}

function service(s: Stores, text: { feed: string }, options: { pending?: () => number; perTick?: number; env?: Record<string, string> } = {}) {
  const dir = directoryStore(s.db);
  const sent: Array<{ audience: Audience; relays?: string[]; event: VerifiedEvent }> = [];
  const r = relays();
  const clock = { now: NOW };
  const lines: string[] = [];
  const indexer = createIndexer({
    db: s.db, dir, queues: queueStore(s.db), events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...ENV, ...options.env }),
    now: () => clock.now,
    fetch: async (url): Promise<FetchResult> => (url === FEED.feedUrl ? { status: 'ok', text: text.feed, etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' }),
    publisher: {
      publish: async (list, audience, only) => {
        for (const event of list) {
          sent.push({ audience, ...(only ? { relays: only } : {}), event });
          if (audience === 'own') r.keep('own', event);
          else if (audience === 'lists' || audience === 'search') for (const relay of only ?? [audience === 'lists' ? LISTS : SEARCH]) r.keep(relay, event);
        }
      },
      fetchOwn: async (filter) => r.read('own', filter),
      fetchFrom: async (relay, filter) => {
        const ids = filter['#d'] ?? [];
        r.asked.push({ relay, ids });
        if (r.answer.none?.has(relay)) return [];
        const asks = r.asked.filter((a) => a.relay === relay).length;
        const leaveOut = r.answer.short?.(relay, asks);
        return r.read(relay, filter).filter((e) => !leaveOut?.has(dOf(e)));
      },
      pendingFor: () => options.pending?.() ?? 0,
      rsvps: async () => new Set(), close: () => {},
    },
    log: (line) => lines.push(line),
    ...(options.perTick ? { itemsReconciledPerTick: options.perTick } : {}),
  });
  if (!dir.get(FEED.d)) dir.add({ ...FEED, name: null, description: null, image: null, location: 'Austin, US', g: '9v6k', foundVia: 'maintainer', addedAt: NOW - DAY });
  const itemId = (uid: string) => eventStore(s.db).byCalendar(FEED.d, 0, NOW + 400 * DAY).find((row) => row.uid === uid)!.id;
  const resent = () => sent.filter((x) => x.relays && isItem(x.event));
  const record = () => JSON.parse(dir.fact('items_reconcile') ?? 'null');
  return { dir, sent, r, clock, lines, indexer, itemId, resent, record, indexPubkey: getPublicKey(s.indexKey) };
}

const pollAgain = (s: Stores) => s.db.savePollState(FEED.d, { ...s.db.pollState(FEED.d), nextPollAt: 0, etag: null, lastModified: null });

test('once a day, an item a relay lacks is sent to it again, alone, as our relay holds it; one it holds is not', async () => {
  const s = stores();
  const svc = service(s, { feed: feed([A, B]) });
  svc.r.lose.set(LISTS, new Set([A.title]));
  await svc.indexer.tick();
  const resent = svc.resent();
  assert.equal(resent.length, 1);
  assert.equal(resent[0]!.audience, 'lists');
  assert.deepEqual(resent[0]!.relays, [LISTS]);
  assert.equal(resent[0]!.event.id, svc.r.held.get('own')!.get(svc.itemId(A.uid))!.id);
  assert.ok(svc.r.held.get(LISTS)!.has(svc.itemId(A.uid)), 'the list relay holds it now');
  assert.deepEqual(svc.record(), {
    at: NOW,
    relays: {
      [SEARCH]: { live: 2, held: 2, missing: 0, older: 0, unanswered: 0, resent: 0 },
      [LISTS]: { live: 2, held: 1, missing: 1, older: 0, unanswered: 0, resent: 1 },
    },
  });
  assert.ok(svc.lines.includes(`event items: reconciled with ${LISTS}: 2 live, 1 held, 1 missing, 0 older, 0 unanswered; 1 sent again`), svc.lines.join('\n'));

  // Not again the same day; again a day later, with nothing to send.
  const asked = svc.r.asked.length;
  svc.clock.now += DAY - 60;
  await svc.indexer.tick();
  assert.equal(svc.r.asked.length, asked);
  svc.clock.now += 120;
  await svc.indexer.tick();
  assert.ok(svc.r.asked.length > asked);
  assert.equal(svc.resent().length, 1);
  assert.equal(svc.record().at, NOW + DAY + 60);
  assert.equal(svc.record().relays[LISTS].held, 2);
});

test('an item a relay holds only in an older version is sent again in its newest', async () => {
  const s = stores();
  const text = { feed: feed([A, B]) };
  const svc = service(s, text);
  await svc.indexer.tick();
  const a = svc.itemId(A.uid);
  text.feed = feed([{ ...A, title: 'First, moved rooms' }, B]);
  svc.r.lose.set(LISTS, new Set(['First, moved rooms']));
  svc.clock.now += 700;
  pollAgain(s);
  await svc.indexer.tick();
  assert.equal(svc.resent().length, 0, 'not due yet');
  svc.clock.now += DAY;
  await svc.indexer.tick();
  const resent = svc.resent();
  assert.equal(resent.length, 1);
  assert.equal(resent[0]!.event.id, svc.r.held.get('own')!.get(a)!.id);
  assert.deepEqual(svc.record().relays[LISTS], { live: 2, held: 1, missing: 0, older: 1, unanswered: 0, resent: 1 });
});

test('an item a relay seemed to lack is asked about again before it is sent', async () => {
  const s = stores();
  const svc = service(s, { feed: feed([A, B]) });
  // The first answer leaves one out; the second has it.
  svc.r.answer.short = (relay, ask) => (relay === LISTS && ask === 1 ? new Set([svc.itemId(A.uid)]) : null);
  await svc.indexer.tick();
  const a = svc.itemId(A.uid);
  assert.equal(svc.resent().length, 0);
  assert.deepEqual(svc.record().relays[LISTS], { live: 2, held: 2, missing: 0, older: 0, unanswered: 0, resent: 0 });
  assert.ok(svc.r.asked.some((x) => x.relay === LISTS && x.ids.length === 1 && x.ids[0] === a), 'asked about it alone');
});

test('a relay that answers nothing is not sent everything again', async () => {
  const s = stores();
  const svc = service(s, { feed: feed([A, B]) });
  svc.r.answer.none = new Set([LISTS]);
  await svc.indexer.tick();
  assert.equal(svc.resent().length, 0);
  assert.deepEqual(svc.record().relays[LISTS], { live: 2, held: 0, missing: 0, older: 0, unanswered: 2, resent: 0 });
});

test('the reconcile waits until the relays\' queues are empty', async () => {
  const s = stores();
  let pending = 3;
  const svc = service(s, { feed: feed([A, B]) }, { pending: () => pending });
  await svc.indexer.tick();
  assert.equal(svc.r.asked.length, 0);
  assert.equal(svc.record(), null);
  pending = 0;
  svc.clock.now += 60;
  await svc.indexer.tick();
  assert.ok(svc.r.asked.length > 0);
  assert.equal(svc.record().at, NOW + 60);
});

test('a paused relay is left out of the round, and the record says so', async () => {
  const s = stores();
  const svc = service(s, { feed: feed([A, B]) });
  relayPauses(svc.dir).set(LISTS, { until: NOW + 3600, strikes: 1 });
  await svc.indexer.tick();
  assert.ok(!svc.r.asked.some((x) => x.relay === LISTS));
  assert.deepEqual(svc.record().relays[LISTS], { paused: true });
  assert.equal(svc.record().relays[SEARCH].held, 2);
});

test('a long list is checked a part each tick, and the round is recorded once it is done', async () => {
  const s = stores();
  const many = Array.from({ length: 150 }, (_, i) => ({ uid: `m${i}@reconcile`, title: `Talk ${i}`, start: NOW + DAY + i * 3600 }));
  const svc = service(s, { feed: feed(many) }, { perTick: 100 });
  await svc.indexer.tick();
  assert.equal(svc.record(), null, 'not done after the first part');
  const first = new Set(svc.r.asked.filter((x) => x.relay === LISTS).flatMap((x) => x.ids));
  assert.equal(first.size, 100);
  svc.clock.now += 60;
  await svc.indexer.tick();
  const all = new Set(svc.r.asked.filter((x) => x.relay === LISTS).flatMap((x) => x.ids));
  assert.equal(all.size, 150);
  assert.equal(svc.record().at, NOW);
  assert.equal(svc.record().relays[LISTS].held, 150);
});

test('while the items stay on our relay, no relay is asked', async () => {
  const s = stores();
  const svc = service(s, { feed: feed([A, B]) }, { env: { EVENTINDEX_PUBLISH_DIRECTORY_OUTSIDE: '0' } });
  await svc.indexer.tick();
  assert.equal(svc.r.asked.length, 0);
  assert.equal(svc.record(), null);
});
