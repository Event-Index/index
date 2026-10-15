import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capPerCalendar, spreadCreatedAt, MAX_EVENTS_PER_CALENDAR } from '../src/rules/limits.ts';

test('a calendar key publishes at most 10,000 events, soonest first, and says so', () => {
  const items = Array.from({ length: 10_050 }, (_, i) => ({ start: 10_050 - i }));
  const { kept, dropped } = capPerCalendar(items);
  assert.equal(MAX_EVENTS_PER_CALENDAR, 10_000);
  assert.equal(kept.length, 10_000);
  assert.equal(dropped, 50);
  assert.equal(kept[0]!.start, 1);
});

test('created_at is spread so no second holds more than the limit', () => {
  const now = 1_800_000_000;
  const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`);
  const assigned = spreadCreatedAt(keys.map((key) => ({ key, last: null })), now, 1000);
  const perSecond = new Map<number, number>();
  for (const t of assigned.values()) perSecond.set(t, (perSecond.get(t) ?? 0) + 1);
  assert.ok([...perSecond.values()].every((n) => n <= 1000));
  assert.ok([...assigned.values()].every((t) => t <= now && t > now - 10));
});

test('a new version is always later than the last one published', () => {
  const now = 1_800_000_000;
  const assigned = spreadCreatedAt([{ key: 'a', last: now }, { key: 'b', last: now - 100 }], now, 1000);
  assert.equal(assigned.get('a'), now + 1);
  assert.equal(assigned.get('b'), now);
});
