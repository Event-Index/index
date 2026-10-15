import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lumaCalendarsFromPage, seedable } from '../src/directory/discover.ts';
import { isPolled, isProjected } from '../src/rules/policy.ts';
import { readPage } from './helpers.ts';

test('a Luma city page leads to the calendars of its events', () => {
  const calendars = lumaCalendarsFromPage(readPage('luma-city-nyc.html'));
  assert.equal(calendars.length, 19);
  const craftnook = calendars.find((c) => c.id === 'cal-BvuRd9eaZnDGBwy')!;
  assert.deepEqual(craftnook, { id: 'cal-BvuRd9eaZnDGBwy', name: 'welcome to the craftnook', slug: 'craftnook', personal: false });
});

test('a platform default calendar is not seeded, and the skip is logged', () => {
  const { seed, skipped } = seedable(lumaCalendarsFromPage(readPage('luma-city-nyc.html')));
  assert.equal(seed.length, 13);
  assert.equal(skipped.length, 6);
  assert.ok(skipped.every((s) => s.reason === 'platform-default-calendar'));
  assert.ok(skipped.some((s) => s.id === 'cal-EpqkMBrIPXa045L'));
});

test('a page without calendar data yields nothing', () => {
  assert.deepEqual(lumaCalendarsFromPage('<html><body>no data</body></html>'), []);
});

const INDEX = 'e1'.repeat(32);

test('only the index key\'s live entries are polled', () => {
  assert.equal(isPolled({ author: INDEX, removed: false }, INDEX), true);
  assert.equal(isPolled({ author: 'f'.repeat(64), removed: false }, INDEX), false);
  assert.equal(isPolled({ author: INDEX, removed: true }, INDEX), false);
});

test('an aggregator is polled for discovery but its events are never projected', () => {
  assert.equal(isProjected({ role: 'aggregator' }), false);
  assert.equal(isProjected({ role: 'calendar' }), true);
});
