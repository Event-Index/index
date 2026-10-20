import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarList, deletionFor, CALENDAR_LIST_MAX } from '../src/project/profile.ts';

const CAL = 'c1'.repeat(32);
const OTHER = 'c2'.repeat(32);
const NOW = Date.UTC(2026, 9, 15, 18) / 1000;
const HOME = 'wss://home.example.org';

test('kind 31924 lists upcoming and recent events, signed or co-hosted, soonest first', () => {
  const event = calendarList({
    name: 'welcome to the craftnook',
    description: null,
    now: NOW,
    d: 'luma:cal-BvuRd9eaZnDGBwy',
    relay: HOME,
    items: [
      { coordinate: `31923:${CAL}:b`, start: NOW + 7200 },
      { coordinate: `31923:${OTHER}:co`, start: NOW + 3600 },
      { coordinate: `31922:${CAL}:recent`, start: NOW - 10 * 86400 },
      { coordinate: `31923:${CAL}:old`, start: NOW - 31 * 86400 },
    ],
  });
  assert.equal(event.kind, 31924);
  assert.equal(event.content, '');
  assert.deepEqual(event.tags, [
    ['d', 'luma:cal-BvuRd9eaZnDGBwy'],
    ['title', 'welcome to the craftnook'],
    ['a', `31922:${CAL}:recent`, HOME],
    ['a', `31923:${OTHER}:co`, HOME],
    ['a', `31923:${CAL}:b`, HOME],
  ]);
});

test('kind 31924 stays within a relay\'s default event size', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ coordinate: `31923:${CAL}:${'f'.repeat(56)}${String(i).padStart(8, '0')}`, start: NOW + i * 60 }));
  const event = calendarList({ name: 'Big', description: 'd'.repeat(2000), now: NOW, items, d: 'meetup:big', relay: HOME });
  assert.equal(event.tags.filter((t) => t[0] === 'a').length, CALENDAR_LIST_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...event, id: 'x'.repeat(64), pubkey: CAL, sig: 'x'.repeat(128), created_at: NOW })) < 65_536);
});

test('a deletion names every version, the address and the kind', () => {
  const event = deletionFor({ versions: ['aa'.repeat(32), 'bb'.repeat(32)], coordinate: `31923:${CAL}:d1`, kind: 31923 });
  assert.equal(event.kind, 5);
  assert.deepEqual(event.tags, [['e', 'aa'.repeat(32)], ['e', 'bb'.repeat(32)], ['a', `31923:${CAL}:d1`], ['k', '31923']]);
});
