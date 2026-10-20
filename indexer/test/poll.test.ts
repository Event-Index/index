import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { openIndexDb } from '../src/store/index-db.ts';
import { pollCalendar, type PollDeps, type Entry } from '../src/poller/poll.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const INDEX = 'e1'.repeat(32);
const H = 3600;
const HOME = 'wss://home.example.org';
// An organizer who has the index publish their calendar as them (B2).
const organizer = generateSecretKey();
const ORGANIZER = getPublicKey(organizer);
const asOrganizer: Partial<PollDeps> = {
  signer: async () => ({ pubkey: ORGANIZER, sign: async (t) => finalizeEvent(t, organizer) }),
  delegated: { relay: HOME },
};

function entry(fixture: string): Entry {
  return { ...identify(feedUrlFor(fixture)), entryName: null };
}

function deps(responses: FetchResult[], clock: { now: number }, extra: Partial<PollDeps> = {}): PollDeps & { sent: VerifiedEvent[]; asked: Array<Record<string, unknown>> } {
  const sent: VerifiedEvent[] = [];
  const asked: Array<Record<string, unknown>> = [];
  return {
    ...extra,
    db: openIndexDb(':memory:'),
    indexPubkey: INDEX,
    now: () => clock.now,
    fetch: async (_url, validators) => {
      asked.push({ ...validators });
      return responses.shift() ?? { status: 'error', code: 'network' };
    },
    publish: async (events) => void sent.push(...events),
    rsvps: async () => new Set<string>(),
    sent,
    asked,
  };
}

const ok = (text: string): FetchResult => ({ status: 'ok', text, etag: '"v1"', lastModified: null, finalUrl: 'https://x' });

test('a mirrored calendar\'s poll keeps its records, each naming its event item, and signs nothing', async () => {
  const clock = { now: NOW };
  const d = deps([ok(readFixture('meetup-pythonsd.ics'))], clock, { itemAddress: (id) => `naddr-of-${id}` });
  const report = await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(report.status, 'published');
  assert.equal(d.sent.length, 0);
  const records = d.db.recordsOf('meetup:pythonsd');
  assert.equal(records.length, 4);
  for (const r of records) assert.match(r.ics.replace(/\r\n /g, ''), new RegExp(`X-EVENTINDEX-NOSTR:naddr-of-${r.id}`));
});

test('a calendar published as its organizer has its events and calendar signed through their signer', async () => {
  const clock = { now: NOW };
  const d = deps([ok(readFixture('meetup-pythonsd.ics'))], clock, asOrganizer);
  const report = await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(report.status, 'published');
  assert.deepEqual(d.sent.map((e) => e.kind).sort(), [31923, 31923, 31923, 31923, 31924]);
  assert.ok(d.sent.every((e) => e.pubkey === ORGANIZER && verifyEvent(e)));
  assert.equal(d.sent.find((e) => e.kind === 31924)!.tags.find((t) => t[0] === 'd')![1], 'meetup:pythonsd');
  assert.equal(d.db.versions(ORGANIZER, 31923, d.sent.find((e) => e.kind === 31923)!.tags[0]![1]!).length, 1);
});

test('the next poll is conditional and a 304 publishes nothing', async () => {
  const clock = { now: NOW };
  const d = deps([ok(readFixture('meetup-pythonsd.ics')), { status: 'not-modified' }], clock, asOrganizer);
  await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  clock.now += 6 * H;
  const before = d.sent.length;
  const report = await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(report.status, 'not-modified');
  assert.equal(d.sent.length, before);
  assert.deepEqual(d.asked[1], { etag: '"v1"', lastModified: null });
});

test('a failed poll backs off and records the failure', async () => {
  const clock = { now: NOW };
  const d = deps([{ status: 'error', code: 'http-503', retryAfter: 7200 }], clock);
  const report = await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(report.status, 'failed');
  const state = d.db.pollState('meetup:pythonsd');
  assert.equal(state.failures, 1);
  assert.equal(state.firstFailureAt, NOW);
  assert.equal(state.nextPollAt, NOW + 7200);
  assert.equal(d.sent.length, 0);
});

test('the next poll comes within the hour when an event starts inside 48 hours', async () => {
  const clock = { now: Date.UTC(2026, 9, 21, 12) / 1000 };
  const d = deps([ok(readFixture('meetup-pythonsd.ics'))], clock);
  await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(d.db.pollState('meetup:pythonsd').nextPollAt, clock.now + H);
});

test('an aggregator is polled but publishes nothing', async () => {
  const clock = { now: NOW };
  const d = deps([ok(readFixture('luma-city-nyc.ics'))], clock);
  const report = await pollCalendar(entry('luma-city-nyc.ics'), null, d);
  assert.equal(report.status, 'aggregator');
  assert.equal(d.sent.length, 0);
});

test('a feed that is not iCalendar is a failed poll', async () => {
  const clock = { now: NOW };
  const d = deps([ok('<html>maintenance</html>')], clock);
  const report = await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  assert.equal(report.status, 'failed');
  assert.equal(d.db.pollState('meetup:pythonsd').failures, 1);
});

test('a calendar published as its organizer has its records name their events', async () => {
  const clock = { now: NOW };
  const d = deps([ok(readFixture('meetup-pythonsd.ics'))], clock, { ...asOrganizer, itemAddress: () => null });
  await pollCalendar(entry('meetup-pythonsd.ics'), null, d);
  const id = d.sent.find((e) => e.kind === 31923)!.tags.find((t) => t[0] === 'r' && t[1]!.includes('/events/byid/'))![1]!.split('/').pop()!.replace('.ics', '');
  const stored = d.db.record(id);
  assert.ok(stored);
  assert.match(stored.ics, /X-EVENTINDEX-NOSTR:naddr1/);
});
