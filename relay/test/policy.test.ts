import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Allowlist, type Lookup, type PolicyEvent } from '../src/policy.ts';

const hex = (c: string) => c.repeat(64);
const INDEX = hex('a');
// A key the index once held, retired: it is nobody's here now.
const RETIRED = hex('b');
const STRANGER = hex('d');
const HOSTED = hex('9');
const allow: Allowlist = { index: INDEX, hosted: new Set([HOSTED]) };
const event = (pubkey: string, kind: number, tags: string[][] = []): PolicyEvent =>
  ({ id: hex('e'), pubkey, kind, tags, content: '', created_at: 1792108194, sig: hex('f') + hex('f') });
const nothingStored: Lookup = async () => false;
const accepts = async (e: PolicyEvent, lookup: Lookup = nothingStored, source = 'IP4') =>
  assert.deepEqual(await decide(e, source, allow, lookup), { action: 'accept' }, `kind ${e.kind} from ${e.pubkey.slice(0, 1)}`);
const refuses = async (e: PolicyEvent, pattern: RegExp, lookup: Lookup = nothingStored) => {
  const d = await decide(e, 'IP4', allow, lookup);
  assert.equal(d.action, 'reject', `kind ${e.kind} from ${e.pubkey.slice(0, 1)}`);
  assert.match((d as { msg: string }).msg, /^blocked: /);
  assert.match((d as { msg: string }).msg, pattern);
};
const ours = (kind: number, pubkey = HOSTED) => ['a', `${kind}:${pubkey}:d1`, 'wss://relay.eventindex.space'];

test('the index key publishes its profile, follows, relay list, calendars, events, deletions and the directory', async () => {
  for (const kind of [0, 3, 5, 10002, 31922, 31923, 31924, 39998, 39999]) await accepts(event(INDEX, kind));
  for (const kind of [1, 7, 30023]) await refuses(event(INDEX, kind), new RegExp(`kind ${kind}`));
  // Its RSVPs and comments follow the rules for anyone's.
  await refuses(event(INDEX, 31925), /RSVP/);
  await refuses(event(INDEX, 1111), /comment/);
});

test('a key the index once held publishes nothing here', async () => {
  for (const kind of [0, 10002, 31922, 31923, 31924]) await refuses(event(RETIRED, kind), new RegExp(`kind ${kind}`));
  await refuses(event(STRANGER, 31925, [ours(31923, RETIRED)]), /RSVP/);
});

test('an organizer the index publishes as, when the relay hosts them, publishes calendars, events and deletions only', async () => {
  for (const kind of [5, 31922, 31923, 31924]) await accepts(event(HOSTED, kind));
  for (const kind of [0, 1, 3, 10002, 39999]) await refuses(event(HOSTED, kind), new RegExp(`kind ${kind}`));
  await accepts(event(STRANGER, 31925, [ours(31923, HOSTED)]), undefined);
  await accepts(event(STRANGER, 1111, [['A', `31923:${HOSTED}:d1`], ['K', '31923']]));
});

test('anyone may RSVP to an event of one of the index\'s keys', async () => {
  await accepts(event(STRANGER, 31925, [['d', 'x'], ours(31923), ['status', 'accepted']]));
  await accepts(event(STRANGER, 31925, [ours(31923, INDEX)]));
  await refuses(event(STRANGER, 31925, [['a', `31923:${STRANGER}:d1`]]), /RSVP/);
  await refuses(event(STRANGER, 31925, [['a', `31924:${HOSTED}:calendar`]]), /RSVP/);
  await refuses(event(STRANGER, 31925, [['e', hex('1')]]), /RSVP/);
  await refuses(event(STRANGER, 31925, [['a', 'not-a-coordinate']]), /RSVP/);
});

test('anyone may comment on an event of one of the index\'s keys, by its root', async () => {
  await accepts(event(STRANGER, 1111, [['A', `31923:${HOSTED}:d1`], ['K', '31923'], ['a', `31923:${HOSTED}:d1`], ['k', '31923']]));
  await accepts(event(STRANGER, 1111, [['A', `31923:${HOSTED}:d1`], ['K', '31923'], ['e', hex('2')], ['k', '1111']]), undefined, 'IP6');
  await accepts(event(STRANGER, 1111, [ours(31922)]));
  await refuses(event(STRANGER, 1111, [['A', `31923:${STRANGER}:d1`], ['K', '31923']]), /comment/);
  await refuses(event(STRANGER, 1111, [['A', `30023:${HOSTED}:post`], ['K', '30023']]), /comment/);
  await refuses(event(STRANGER, 1111, [['E', hex('3')], ['K', '1']]), /comment/);
});

test('anyone may delete their own events stored here, and only those', async () => {
  const stored = new Set([`id:${hex('4')}:${STRANGER}`, `addr:31925:${STRANGER}:x`]);
  const lookup: Lookup = async (target, author) =>
    stored.has(target.type === 'id' ? `id:${target.id}:${author}` : `addr:${target.kind}:${author}:${target.d}`);
  await accepts(event(STRANGER, 5, [['e', hex('4')], ['k', '1111']]), lookup);
  await accepts(event(STRANGER, 5, [['a', `31925:${STRANGER}:x`], ['k', '31925']]), lookup);
  await accepts(event(STRANGER, 5, [['e', hex('4')], ['a', `31925:${STRANGER}:x`]]), lookup);
  await refuses(event(STRANGER, 5, [['e', hex('5')]]), /your own events/, lookup);
  await refuses(event(STRANGER, 5, [['a', `31923:${HOSTED}:d1`]]), /your own events/, lookup);
  await refuses(event(STRANGER, 5, [['e', hex('4')], ['e', hex('5')]]), /your own events/, lookup);
  await refuses(event(STRANGER, 5, [['k', '1']]), /your own events/, lookup);
});

test('everything else is refused with a clear reason', async () => {
  for (const kind of [0, 1, 3, 7, 10002, 30023, 31922, 31923, 31924, 39999]) await refuses(event(STRANGER, kind), /Event Index/);
});

test('events the operator loads (import, sync, stream) are not filtered', async () => {
  for (const source of ['Import', 'Sync', 'Stream']) await accepts(event(STRANGER, 1), nothingStored, source);
});

test('with no allowlist read yet, the index\'s own keys are refused like anyone', async () => {
  const empty: Allowlist = { index: null, hosted: new Set() };
  const d = await decide(event(INDEX, 39999), 'IP4', empty, nothingStored);
  assert.equal(d.action, 'reject');
});

test('the index key\'s event items are taken however many come, and their deletions too', async () => {
  const items = Array.from({ length: 5000 }, (_, i) => event(INDEX, 39999, [['d', `item${i}`], ['z', `39998:${hex('9')}:events`], ['title', `Event ${i}`], ['start', '1793223000']]));
  const started = Date.now();
  for (const item of items) await accepts(item);
  assert.ok(Date.now() - started < 5000, 'the policy keeps up with a full publish');
  await accepts(event(INDEX, 5, [['e', hex('1')], ['a', `39999:${INDEX}:item0`], ['k', '39999']]));
});
