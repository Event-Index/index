import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedEntries, type Seed } from '../src/directory/seed.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readFixture } from './helpers.ts';

const INDEX = 'e1'.repeat(32);
const NOW = 1_792_000_000;

const FEEDS: Record<string, string> = {
  'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy': readFixture('luma-calendar-craftnook.ics'),
  'https://api.luma.com/ics/get?entity=calendar&id=cal-EpqkMBrIPXa045L': readFixture('luma-personal-newlab.ics'),
  'https://api.luma.com/ics/get?entity=calendar&id=cal-f6iLyfD3TN5qUO2': '<html>gone</html>',
};
const fetch = async (url: string): Promise<FetchResult> =>
  FEEDS[url] ? { status: 'ok', text: FEEDS[url]!, etag: null, lastModified: null, finalUrl: url } : { status: 'error', code: 'http-404' };

const seed: Seed = {
  city: 'New York', country: 'US', geonames_id: 5128581, source: 'luma', found_via: 'luma:discplace-Izx1rQVSh8njYpP', found_at: '2026-10-15',
  calendars: ['cal-BvuRd9eaZnDGBwy', 'cal-EpqkMBrIPXa045L', 'cal-f6iLyfD3TN5qUO2', 'cal-missing00000'],
  skipped: [],
};

test('a seed list becomes unsigned entries for the calendars that validate', async () => {
  const { entries, report } = await seedEntries(seed, { fetch, indexPubkey: INDEX, now: NOW, keyFor: (d) => `key-of-${d}` });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(entry!.tags.slice(0, 5), [
    ['d', 'luma:cal-BvuRd9eaZnDGBwy'],
    ['z', `39998:${INDEX}:event-calendars`],
    ['name', 'welcome to the craftnook'],
    ['role', 'calendar'],
    ['p', 'key-of-luma:cal-BvuRd9eaZnDGBwy'],
  ]);
  assert.deepEqual(entry!.tags.find((t) => t[0] === 'location'), ['location', 'New York, US']);
  assert.equal(entry!.created_at, NOW);
  assert.deepEqual(report, [
    { id: 'cal-BvuRd9eaZnDGBwy', outcome: 'filed' },
    { id: 'cal-EpqkMBrIPXa045L', outcome: 'skipped', reason: 'platform-default-calendar' },
    { id: 'cal-f6iLyfD3TN5qUO2', outcome: 'refused', reason: 'not-icalendar' },
    { id: 'cal-missing00000', outcome: 'refused', reason: 'http-404' },
  ]);
});

test('entries filed together spread their created_at', async () => {
  const many: Seed = { ...seed, calendars: Array.from({ length: 5 }, () => 'cal-BvuRd9eaZnDGBwy') };
  const { entries } = await seedEntries(many, { fetch, indexPubkey: INDEX, now: NOW, keyFor: () => 'k', perSecond: 2 });
  assert.equal(entries.length, 1, 'one entry per d');
  const spread = await seedEntries({ ...seed, calendars: ['cal-BvuRd9eaZnDGBwy', 'cal-EpqkMBrIPXa045L'] }, { fetch, indexPubkey: INDEX, now: NOW, keyFor: () => 'k', perSecond: 1, includeDefaultCalendars: true });
  assert.deepEqual(spread.entries.map((e) => e.created_at), [NOW, NOW - 1]);
});

test('a seed item may name where it was found, and skipped items are not fetched', async () => {
  const fetched: string[] = [];
  const mixed: Seed = {
    ...seed,
    calendars: [{ id: 'cal-BvuRd9eaZnDGBwy', found_via: 'btcmap:example-community' }],
    skipped: [{ id: 'cal-EpqkMBrIPXa045L', reason: 'platform-default-calendar' }],
  };
  const { entries, report } = await seedEntries(mixed, {
    fetch: async (url) => {
      fetched.push(url);
      return fetch(url);
    },
    indexPubkey: INDEX,
    now: NOW,
    keyFor: () => 'k',
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(report, [{ id: 'cal-BvuRd9eaZnDGBwy', outcome: 'filed' }]);
  assert.deepEqual(fetched, ['https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy']);
});

test('a default calendar reviewed as an organization is filed', async () => {
  const reviewed: Seed = { ...seed, calendars: [{ id: 'cal-EpqkMBrIPXa045L', reviewed: '2026-10-20' }], skipped: [] };
  const { entries, report } = await seedEntries(reviewed, { fetch, indexPubkey: INDEX, now: NOW, keyFor: () => 'k' });
  assert.deepEqual(report, [{ id: 'cal-EpqkMBrIPXa045L', outcome: 'filed' }]);
  assert.deepEqual(entries[0]!.tags.find((t) => t[0] === 'name'), ['name', 'Newlab Brooklyn']);
});
