import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { nostrD, publicEventId, base32 } from '../src/project/ids.ts';
import { occurrenceKey } from '../src/project/time.ts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('nostrD is the sha256 of the UID', () => {
  assert.equal(nostrD('evt-8obJGsASb0HxSiX@events.lu.ma'), sha('evt-8obJGsASb0HxSiX@events.lu.ma'));
});

test('nostrD of an occurrence hashes the UID and the occurrence key', () => {
  assert.equal(nostrD('weekly@x', '1792515600'), sha('weekly@x:1792515600'));
});

test('occurrenceKey is the original start in unix seconds, or YYYY-MM-DD for a date', () => {
  const utc = ICAL.Time.fromData({ year: 2026, month: 10, day: 20, hour: 17, minute: 0, second: 0 }, ICAL.Timezone.utcTimezone);
  assert.equal(occurrenceKey(utc, null), String(Date.UTC(2026, 9, 20, 17) / 1000));
  const day = ICAL.Time.fromData({ year: 2026, month: 10, day: 24, isDate: true });
  assert.equal(occurrenceKey(day, null), '2026-10-24');
});

test('occurrenceKey reads a floating recurrence id in the calendar zone, else UTC', () => {
  const floating = ICAL.Time.fromData({ year: 2026, month: 10, day: 20, hour: 19, minute: 0, second: 0 });
  assert.equal(occurrenceKey(floating, null), String(Date.UTC(2026, 9, 20, 19) / 1000));
  assert.equal(occurrenceKey(floating, 'America/Chicago'), String(Date.UTC(2026, 9, 21, 0) / 1000));
});

test('base32 is RFC 4648 lowercase without padding', () => {
  assert.equal(base32(new TextEncoder().encode('foobar')), 'mzxw6ytboi');
  assert.equal(base32(new Uint8Array([])), '');
});

test('publicEventId is 32 base32 characters derived from the calendar d and the nostr d', () => {
  const id = publicEventId('luma:cal-BvuRd9eaZnDGBwy', nostrD('evt-1JShHuzUFGWW57n@events.lu.ma'));
  assert.match(id, /^[a-z2-7]{32}$/);
  assert.equal(id, publicEventId('luma:cal-BvuRd9eaZnDGBwy', nostrD('evt-1JShHuzUFGWW57n@events.lu.ma')));
  assert.notEqual(id, publicEventId('luma:cal-f6iLyfD3TN5qUO2', nostrD('evt-1JShHuzUFGWW57n@events.lu.ma')));
  const digest = createHash('sha256').update(`luma:cal-BvuRd9eaZnDGBwy\u0000${nostrD('evt-1JShHuzUFGWW57n@events.lu.ma')}`).digest();
  assert.equal(id, base32(digest.subarray(0, 20)));
});
