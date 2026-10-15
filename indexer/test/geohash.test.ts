import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeohash } from '../src/project/geohash.ts';

test('encodeGeohash matches published vectors', () => {
  assert.equal(encodeGeohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
  assert.equal(encodeGeohash(42.6, -5.6, 5), 'ezs42');
  assert.equal(encodeGeohash(-25.382708, -49.265506, 9), '6gkzwgjzn');
});

test('encodeGeohash rejects coordinates off the globe', () => {
  assert.throws(() => encodeGeohash(91, 0, 9), RangeError);
  assert.throws(() => encodeGeohash(0, -181, 9), RangeError);
  assert.throws(() => encodeGeohash(Number.NaN, 0, 9), RangeError);
});
