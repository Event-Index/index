import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneAt } from '../src/project/venue-zone.ts';

test('a venue\'s zone comes from the time-zone boundaries at its coordinates', () => {
  // The events whose zone was once taken from their calendar's city.
  assert.equal(zoneAt(59.3293, 18.0686), 'Europe/Stockholm');
  assert.equal(zoneAt(14.2117, 121.1653), 'Asia/Manila');
  assert.equal(zoneAt(7.9647, -11.7383), 'Africa/Freetown');
  assert.equal(zoneAt(13.0059, 5.2476), 'Africa/Lagos');
  assert.equal(zoneAt(47.4124, 9.7417), 'Europe/Vienna');
  assert.equal(zoneAt(38.8951, -77.0222), 'America/New_York');
  assert.equal(zoneAt(Number.NaN, 0), null);
  assert.equal(zoneAt(91, 0), null);
});

test('a point at sea names no zone, so the event takes its calendar\'s', () => {
  assert.equal(zoneAt(30, -40), null);
  assert.equal(zoneAt(0, 0), null);
});
