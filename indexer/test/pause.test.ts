import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
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

const FIXTURE = 'luma-calendar-craftnook.ics';
const D = identify(feedUrlFor(FIXTURE)).d;
// Another calendar, left alone by what is done to the first.
const OTHER_FIXTURE = 'luma-calendar-journaling.ics';
const OTHER = identify(feedUrlFor(OTHER_FIXTURE)).d;
const OUTSIDE = { EVENTINDEX_PUBLISH_TO_GENERAL_RELAYS: '1', EVENTINDEX_SEARCH_RELAYS: 'wss://search.test', EVENTINDEX_GENERAL_RELAYS: 'wss://general.test' };

interface Stores {
  db: IndexDb;
  vault: Vault;
  indexKey: Uint8Array;
}

function stores(): Stores {
  return { db: openIndexDb(':memory:'), vault: openVault(':memory:', new Uint8Array(randomBytes(32))), indexKey: generateSecretKey() };
}

function service(s: Stores, env: Record<string, string>, options: { text?: string; fetchOwn?: () => void; other?: boolean; pending?: () => number } = {}) {
  const dir = directoryStore(s.db);
  const queues = queueStore(s.db);
  const sent: Array<{ audience: Audience; event: VerifiedEvent }> = [];
  const log: string[] = [];
  const url = identify(feedUrlFor(FIXTURE)).feedUrl;
  const otherUrl = identify(feedUrlFor(OTHER_FIXTURE)).feedUrl;
  const indexer = createIndexer({
    db: s.db, dir, queues, events: eventStore(s.db), vault: s.vault, indexKey: s.indexKey,
    settings: loadSettings({ EVENTINDEX_DATA_DIR: '/nonexistent', ...OUTSIDE, ...env }),
    now: () => NOW,
    fetch: async (u): Promise<FetchResult> => (u === url
      ? { status: 'ok', text: options.text ?? readFixture(FIXTURE), etag: null, lastModified: null, finalUrl: u }
      : u === otherUrl ? { status: 'ok', text: readFixture(OTHER_FIXTURE), etag: null, lastModified: null, finalUrl: u } : { status: 'error', code: 'http-404' }),
    publisher: {
      publish: async (list, audience) => void sent.push(...list.map((event) => ({ audience, event }))),
      rsvps: async () => new Set(),
      fetchOwn: async () => {
        options.fetchOwn?.();
        return [];
      },
      pendingFor: () => 0,
      ...(options.pending ? { pending: options.pending } : {}),
      close: () => {},
    },
    log: (line) => log.push(line),
  });
  if (!dir.get(D)) {
    dir.add({ ...identify(feedUrlFor(FIXTURE)), name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'maintainer', addedAt: NOW - 86400 });
  }
  if (options.other && !dir.get(OTHER)) {
    dir.add({ ...identify(feedUrlFor(OTHER_FIXTURE)), name: null, description: null, image: null, location: 'New York, US', g: 'dr5r', foundVia: 'maintainer', addedAt: NOW - 86400 });
  }
  return { dir, queues, sent, log, indexer, indexPubkey: getPublicKey(s.indexKey), events: eventStore(s.db) };
}

const PAUSED = { EVENTINDEX_CALENDAR_KEYS_PAUSED: '1' };

test('with calendar keys paused, a new calendar is read and its records kept, but it gets no key and nothing is signed for it', async () => {
  const s = stores();
  const svc = service(s, PAUSED);
  const report = await svc.indexer.tick();
  assert.ok(report.polled.includes(D));
  assert.equal(s.vault.pubkeyFor(D), null);
  assert.equal(svc.dir.get(D)!.pubkey, null);
  assert.ok(s.db.recordsOf(D).length > 0, 'its records are served');
  assert.ok(svc.events.countByCalendar(D) > 0, 'its events are listed and searchable');
  assert.ok(svc.sent.every((x) => x.event.pubkey === svc.indexPubkey), 'only the index key signs');
  assert.ok(!svc.sent.some((x) => x.event.kind === 39999 && x.event.tags.some((t) => t[0] === 'd' && t[1] === D)), 'no entry until it has a key');
  const follows = svc.sent.filter((x) => x.event.kind === 3).at(-1)!.event.tags.filter((t) => t[0] === 'p');
  assert.deepEqual(follows, []);
  assert.ok(svc.log.some((l) => l.includes('calendar keys paused')), svc.log.join('\n'));
});

test('with calendar keys paused, a calendar that has a key publishes to the index\'s relay only', async () => {
  const s = stores();
  const before = service(s, {});
  await before.indexer.tick();
  const key = s.vault.pubkeyFor(D)!;
  assert.ok(before.sent.some((x) => x.audience !== 'own' && x.event.pubkey === key), 'outside, before the pause');

  // The feed changes; the calendar is polled again with the pause on.
  s.db.savePollState(D, { ...s.db.pollState(D), nextPollAt: 0, etag: null, lastModified: null });
  const text = readFixture(FIXTURE).replace(/^SUMMARY:(.*)$/gm, 'SUMMARY:$1 (moved)');
  const paused = service(s, PAUSED, { text });
  await paused.indexer.tick();
  const byKey = paused.sent.filter((x) => x.event.pubkey === key);
  assert.ok(byKey.some((x) => x.audience === 'own' && (x.event.kind === 31923 || x.event.kind === 31922)), 'the update reaches the index\'s relay');
  assert.deepEqual(byKey.filter((x) => x.audience !== 'own').map((x) => `${x.audience} ${x.event.kind}`), [], 'and no outside relay');
  assert.equal(s.vault.pubkeyFor(D), key);
});

test('with calendar keys paused, nothing is sent again to outside relays, and once it is off they get all of it again', async () => {
  let reads = 0;
  const s = stores();
  const dir = directoryStore(s.db);
  // A relay that had everything before the pause.
  dir.setFact('outside_backfill wss://search.test', '1');
  await service(s, PAUSED, { fetchOwn: () => { reads += 1; } }).indexer.tick();
  assert.equal(reads, 0);
  assert.equal(dir.fact('outside_backfill wss://search.test'), null, 'it is to get what it missed');
  await service(s, {}, { fetchOwn: () => { reads += 1; } }).indexer.tick();
  assert.ok(reads > 0, 'the backfill runs once the pause is off');
});

test('with calendar keys paused, a removal keeps the calendar\'s key and deletes its events on the index\'s relay', async () => {
  const s = stores();
  await service(s, {}).indexer.tick();
  const key = s.vault.pubkeyFor(D)!;
  const paused = service(s, PAUSED);
  const { id } = paused.queues.requestRemoval({ d: D, message: null, at: NOW });
  paused.queues.resolveRemoval(id, 'approved', NOW);
  const report = await paused.indexer.tick();
  assert.deepEqual(report.removed, [D]);
  assert.equal(s.vault.pubkeyFor(D), key, 'the key stays, to sign its own deletions outside later');
  assert.ok(paused.sent.some((x) => x.audience === 'own' && x.event.pubkey === key && x.event.kind === 5));
});

// What a calendar key signed of kinds 31922, 31923 and 31924, by address, from what reached the index's relay.
function signedBy(sent: Array<{ audience: Audience; event: VerifiedEvent }>, key: string): Map<string, string[]> {
  const byAddress = new Map<string, string[]>();
  for (const { audience, event } of sent) {
    if (audience !== 'own' || event.pubkey !== key || ![31922, 31923, 31924].includes(event.kind)) continue;
    const address = `${event.kind}:${key}:${event.tags.find((t) => t[0] === 'd')![1]}`;
    byAddress.set(address, [...(byAddress.get(address) ?? []), event.id]);
  }
  return byAddress;
}

test('a removal while calendar keys are paused clears that calendar from the outside relays, and nothing else', async () => {
  const s = stores();
  const before = service(s, {}, { other: true });
  await before.indexer.tick();
  const key = s.vault.pubkeyFor(D)!;
  const otherKey = s.vault.pubkeyFor(OTHER)!;
  const signed = signedBy(before.sent, key);
  assert.ok(signed.size > 2);

  const paused = service(s, PAUSED, { other: true });
  const { id } = paused.queues.requestRemoval({ d: D, message: null, at: NOW });
  paused.queues.resolveRemoval(id, 'approved', NOW);
  await paused.indexer.tick();

  // Everything the key signed, the removal's own last calendar included.
  for (const [address, ids] of signedBy(paused.sent, key)) signed.set(address, [...(signed.get(address) ?? []), ...ids]);
  const outside = paused.sent.filter((x) => x.audience !== 'own' && x.event.pubkey !== paused.indexPubkey);
  assert.ok(outside.every((x) => x.event.pubkey === key), 'nothing for the other calendar');
  assert.ok(!paused.sent.some((x) => x.audience !== 'own' && x.event.pubkey === otherKey));
  assert.deepEqual([...new Set(outside.map((x) => x.audience))].sort(), ['general', 'profiles', 'search']);
  for (const audience of ['general', 'profiles', 'search']) {
    const to = outside.filter((x) => x.audience === audience).map((x) => x.event);
    assert.deepEqual(to.map((e) => e.kind).sort((a, b) => a - b), [0, ...Array(signed.size).fill(5)], audience);
    const profile = JSON.parse(to.find((e) => e.kind === 0)!.content) as Record<string, string>;
    assert.deepEqual(Object.keys(profile).sort(), ['about', 'name']);
    assert.equal(profile['name'], 'Retired Event Index mirror');
    assert.match(profile['about']!, /https:\/\/eventindex\.space\/calendar\/luma-cal-bvurd9eazndgbwy/);
    const deletions = new Map(to.filter((e) => e.kind === 5).map((e) => [e.tags.find((t) => t[0] === 'a')![1], e]));
    for (const [address, ids] of signed) {
      const deletion = deletions.get(address);
      assert.ok(deletion, `${audience}: ${address} is deleted`);
      assert.deepEqual(deletion.tags, [...ids.map((i) => ['e', i]), ['a', address], ['k', address.split(':')[0]]]);
    }
  }
  assert.equal(s.vault.pubkeyFor(D), key, 'no key material is deleted');
  assert.equal(s.vault.pubkeyFor(OTHER), otherKey);
  // On the index's relay the removal is as it always was.
  assert.ok(paused.sent.some((x) => x.audience === 'own' && x.event.pubkey === key && x.event.kind === 0
    && (JSON.parse(x.event.content) as Record<string, string>)['about']!.includes('at its organizer\'s request')));
  assert.ok(!paused.sent.some((x) => x.audience === 'own' && x.event.pubkey === key && (JSON.parse(x.event.content || '{}') as Record<string, string>)['name'] === 'Retired Event Index mirror'));
});

test('the clearing of a calendar is sent again after a restart, until the outside relays have taken it', async () => {
  const s = stores();
  await service(s, {}).indexer.tick();
  const key = s.vault.pubkeyFor(D)!;
  let queued = 5;
  const paused = service(s, PAUSED, { pending: () => queued });
  const { id } = paused.queues.requestRemoval({ d: D, message: null, at: NOW });
  paused.queues.resolveRemoval(id, 'approved', NOW);
  await paused.indexer.tick();
  const first = paused.sent.filter((x) => x.audience !== 'own' && x.event.pubkey === key).length;
  assert.ok(first > 0);

  // The service restarts before the outside relays took it all.
  const restarted = service(s, PAUSED, { pending: () => queued });
  await restarted.indexer.tick();
  assert.equal(restarted.sent.filter((x) => x.audience !== 'own' && x.event.pubkey === key).length, first, 'sent again in full');
  await restarted.indexer.tick();
  assert.equal(restarted.sent.filter((x) => x.audience !== 'own' && x.event.pubkey === key).length, first, 'once per run');
  queued = 0;
  await restarted.indexer.tick();
  assert.ok(restarted.log.some((l) => l.includes(`outside relays: ${D} cleared`)), restarted.log.join('\n'));
  const again = service(s, PAUSED);
  await again.indexer.tick();
  assert.equal(again.sent.filter((x) => x.audience !== 'own' && x.event.pubkey === key).length, 0, 'not after it is done');
});

test('a removal with calendar keys not paused is as it always was: no clearing outside, and the key is deleted', async () => {
  const s = stores();
  const svc = service(s, {});
  await svc.indexer.tick();
  const key = s.vault.pubkeyFor(D)!;
  const { id } = svc.queues.requestRemoval({ d: D, message: null, at: NOW });
  svc.queues.resolveRemoval(id, 'approved', NOW);
  const before = svc.sent.length;
  await svc.indexer.tick();
  const after = svc.sent.slice(before).filter((x) => x.event.pubkey === key);
  assert.ok(!after.some((x) => x.event.kind === 0 && (JSON.parse(x.event.content) as Record<string, string>)['name'] === 'Retired Event Index mirror'));
  assert.ok(after.some((x) => x.audience !== 'own' && x.event.kind === 5), 'its deletions go out as before');
  assert.equal(s.vault.pubkeyFor(D), null);
});

