import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPollAt, isStale, parseRetryAfter } from '../src/rules/schedule.ts';

const NOW = Date.UTC(2026, 9, 15, 18) / 1000;
const H = 3600;

test('a feed is polled every 6 hours', () => {
  assert.equal(nextPollAt({ now: NOW, refreshInterval: null, nextEventStart: NOW + 5 * 86400, failures: 0, retryAfter: null }), NOW + 6 * H);
});

test('a feed with an event inside 48 hours is polled every hour', () => {
  assert.equal(nextPollAt({ now: NOW, refreshInterval: null, nextEventStart: NOW + 47 * H, failures: 0, retryAfter: null }), NOW + H);
});

test('REFRESH-INTERVAL is honored as the shortest interval, up to a day', () => {
  assert.equal(nextPollAt({ now: NOW, refreshInterval: 12 * H, nextEventStart: NOW + 2 * H, failures: 0, retryAfter: null }), NOW + 12 * H);
  assert.equal(nextPollAt({ now: NOW, refreshInterval: 30 * 60, nextEventStart: null, failures: 0, retryAfter: null }), NOW + 6 * H);
  assert.equal(nextPollAt({ now: NOW, refreshInterval: 7 * 86400, nextEventStart: null, failures: 0, retryAfter: null }), NOW + 24 * H);
});

test('failures back off exponentially from 15 minutes to a day', () => {
  const after = (failures: number) => nextPollAt({ now: NOW, refreshInterval: null, nextEventStart: null, failures, retryAfter: null }) - NOW;
  assert.equal(after(1), 15 * 60);
  assert.equal(after(2), 30 * 60);
  assert.equal(after(3), 60 * 60);
  assert.equal(after(10), 24 * H);
});

test('Retry-After is respected', () => {
  assert.equal(nextPollAt({ now: NOW, refreshInterval: null, nextEventStart: null, failures: 1, retryAfter: 2 * H }), NOW + 2 * H);
  assert.equal(parseRetryAfter('120', NOW), 120);
  assert.equal(parseRetryAfter(new Date((NOW + 600) * 1000).toUTCString(), NOW), 600);
  assert.equal(parseRetryAfter('soon', NOW), null);
});

test('an entry is stale after 14 days of failure', () => {
  assert.equal(isStale({ now: NOW, firstFailureAt: NOW - 14 * 86400 }), true);
  assert.equal(isStale({ now: NOW, firstFailureAt: NOW - 13 * 86400 }), false);
  assert.equal(isStale({ now: NOW, firstFailureAt: null }), false);
});
