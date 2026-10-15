// End to end against a local relay: `nak serve` (skipped when nak is not
// installed). Keys are generated for the test and thrown away.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { openIndexDb } from '../src/store/index-db.ts';
import { projectFeed, cohostPlan } from '../src/project/projector.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const hasNak = spawnSync('nak', ['--version']).status === 0;
let relay: ChildProcess | null = null;
let url = '';
const pool = new SimplePool();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('relay did not start');
}

before(async () => {
  if (!hasNak) return;
  const port = await freePort();
  url = `ws://127.0.0.1:${port}`;
  relay = spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '-qq'], { stdio: 'ignore' });
  await waitForPort(port);
});

after(() => {
  if (url) pool.close([url]);
  relay?.kill();
});

const calendarKey = generateSecretKey();
const indexKey = generateSecretKey();
const calendarPubkey = getPublicKey(calendarKey);
const indexPubkey = getPublicKey(indexKey);
const db = openIndexDb(':memory:');

async function publish(text: string, now: number): Promise<Event[]> {
  const feed = normalizeFeed(text, identify(feedUrlFor('luma-calendar-craftnook.ics')));
  const result = projectFeed({
    feed, calendarPubkey, indexPubkey, keyOf: () => calendarPubkey, db, now,
    hasRsvps: () => false, plan: cohostPlan([feed], now),
  });
  const signed: Event[] = [];
  for (const planned of result.publish) {
    const event = finalizeEvent(planned.template, calendarKey);
    await Promise.all(pool.publish([url], event));
    db.markPublished({ ...planned.record, eventId: event.id });
    signed.push(event);
  }
  db.savePresence(feed.context.d, result.presence);
  return signed;
}

const header = () => `39998:${indexPubkey}:events`;

const PARTY = nostrD('evt-PDzqdd9OU1nQXYz@events.lu.ma');

test('a calendar\'s projections can be read back by list, day and address', { skip: !hasNak && 'nak is not installed' }, async () => {
  const sent = await publish(readFixture('luma-calendar-craftnook.ics'), NOW);
  assert.equal(sent.filter((e) => e.kind === 31923).length, 4);

  const listed = await pool.querySync([url], { kinds: [31922, 31923], '#z': [header()] });
  assert.equal(listed.length, 4);
  assert.ok(listed.every((e) => e.pubkey === calendarPubkey));

  const day = String(Math.floor(Date.UTC(2026, 9, 24, 16) / 86_400_000));
  const onDay = await pool.querySync([url], { kinds: [31923], '#D': [day] });
  assert.deepEqual(onDay.map((e) => e.tags.find((t) => t[0] === 'd')![1]), [PARTY]);

  const profile = await pool.querySync([url], { kinds: [0], authors: [calendarPubkey] });
  assert.equal(JSON.parse(profile[0]!.content).nip05, 'luma-cal-bvurd9eazndgbwy@eventindex.space');
  const calendar = await pool.querySync([url], { kinds: [31924], authors: [calendarPubkey], '#d': ['calendar'] });
  assert.equal(calendar[0]!.tags.filter((t) => t[0] === 'a').length, 4);
});

test('an edit replaces the event at its address', { skip: !hasNak && 'nak is not installed' }, async () => {
  const party = PARTY;
  const edited = readFixture('luma-calendar-craftnook.ics').replace('SUMMARY:craftyween party', 'SUMMARY:craftyween party (moved indoors)');
  const sent = await publish(edited, NOW);
  assert.equal(sent.filter((e) => e.kind === 31923).length, 1);
  const after = await pool.querySync([url], { kinds: [31923], authors: [calendarPubkey], '#d': [party] });
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]!.tags.find((t) => t[0] === 'title'), ['title', 'craftyween party (moved indoors)']);
});

test('a deletion removes every version at the address', { skip: !hasNak && 'nak is not installed' }, async () => {
  const party = PARTY;
  const versions = db.versions(calendarPubkey, 31923, party);
  assert.equal(versions.length, 2);
  const deletion = finalizeEvent({
    kind: 5,
    created_at: NOW + 10,
    content: '',
    tags: [...versions.map((id) => ['e', id]), ['a', `31923:${calendarPubkey}:${party}`], ['k', '31923']],
  }, calendarKey);
  await Promise.all(pool.publish([url], deletion));
  const remaining = await pool.querySync([url], { kinds: [31923], authors: [calendarPubkey], '#d': [party] });
  assert.equal(remaining.length, 0);
});
