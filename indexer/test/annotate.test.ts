import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from 'nostr-tools/nip19';
import { normalizeFeed, type NormalizedFeed } from '../src/normalize/normalize.ts';
import { cohostPlan } from '../src/project/projector.ts';
import { annotate, naddrFor } from '../src/project/annotate.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const feed = (fixture: string): NormalizedFeed => normalizeFeed(readFixture(fixture), identify(feedUrlFor(fixture)));

test('naddrFor names a projection by kind, key, d and relay', () => {
  const pubkey = 'c1'.repeat(32);
  const decoded = decode(naddrFor(pubkey, 31923, 'abc', ['wss://relay.eventindex.space']));
  assert.equal(decoded.type, 'naddr');
  assert.deepEqual(decoded.data, { kind: 31923, pubkey, identifier: 'abc', relays: ['wss://relay.eventindex.space'] });
});

test('a co-host\'s copy of an event names the record it duplicates', () => {
  const craftnook = feed('luma-calendar-craftnook.ics');
  const journaling = feed('luma-calendar-journaling.ics');
  const plan = cohostPlan([craftnook, journaling], NOW);
  const copy = journaling.records.find((r) => r.uid === 'evt-ILpIInTRKRV1pnY@events.lu.ma')!;
  const signer = craftnook.records.find((r) => r.uid === 'evt-ILpIInTRKRV1pnY@events.lu.ma')!;
  const canonical = plan.canonicalOf.get(copy.id);
  assert.equal(canonical, `https://api.eventindex.space/api/1.0/events/byid/${signer.id}`);
  annotate(copy, new Map([[copy.id, { canonical }]]));
  assert.equal(copy.master!.getFirstPropertyValue('x-eventindex-canonical'), canonical);
  assert.equal(plan.canonicalOf.get(signer.id), undefined);
});

test('annotations replace earlier ones and are removed when they no longer apply', () => {
  const f = feed('luma-calendar-craftnook.ics');
  const record = f.records.find((r) => r.uid === 'evt-PDzqdd9OU1nQXYz@events.lu.ma')!;
  const naddr = naddrFor('c1'.repeat(32), 31923, nostrD(record.uid), ['wss://relay.eventindex.space']);
  annotate(record, new Map([[record.id, { canonical: 'https://x/1', nostr: naddr }]]));
  annotate(record, new Map([[record.id, { nostr: naddr }]]));
  assert.equal(record.master!.getAllProperties('x-eventindex-nostr').length, 1);
  assert.equal(record.master!.getFirstPropertyValue('x-eventindex-nostr'), naddr);
  assert.equal(record.master!.hasProperty('x-eventindex-canonical'), false);
});
