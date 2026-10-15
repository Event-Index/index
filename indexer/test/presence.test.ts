import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed } from '../src/normalize/normalize.ts';
import { occurrences, projectionWindow } from '../src/project/window.ts';
import { reconcilePoll, emptyPresence, observe, type PresenceState, type PollDecision, type Seen } from '../src/rules/presence.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import { readFixture, NOW } from './helpers.ts';

const HOUR = 3600;

function poll(name: string): Seen[] {
  const feed = normalizeFeed(readFixture(`sequences/${name}.ics`), identify('https://fixture.eventindex.space/neighborhood.ics'));
  return observe(feed.records.flatMap((r) => occurrences(r, projectionWindow(NOW), { calendarD: feed.context.d }).items));
}

function run(sequence: Array<[string, number]>, rsvps: Set<string> = new Set()): { state: PresenceState; decisions: PollDecision[] } {
  let state = emptyPresence();
  const decisions: PollDecision[] = [];
  for (const [name, hours] of sequence) {
    const at = NOW + hours * HOUR;
    const decision = reconcilePoll(state, { at, ok: true, seen: poll(name) }, (coordinate) => rsvps.has(coordinate));
    decisions.push(decision);
    state = decision.state;
  }
  return { state, decisions };
}

const C = `31923:${nostrD('seq-c@fixture.eventindex.space')}`;
const B = `31923:${nostrD('seq-b@fixture.eventindex.space')}`;

test('a flapping event is never withdrawn', () => {
  const { decisions } = run([['poll-full', 0], ['poll-without-b', 6], ['poll-full', 12], ['poll-without-b', 18], ['poll-without-b', 24], ['poll-full', 30]]);
  assert.ok(decisions.every((d) => d.withdraw.length === 0));
});

test('an event missing from 3 polls spanning less than 24 hours stays', () => {
  const { decisions } = run([['poll-full', 0], ['poll-without-c', 6], ['poll-without-c', 12], ['poll-without-c', 18]]);
  assert.ok(decisions.every((d) => d.withdraw.length === 0));
});

test('an event missing from 3 consecutive polls spanning 24 hours is withdrawn', () => {
  const { decisions, state } = run([['poll-full', 0], ['poll-without-c', 6], ['poll-without-c', 12], ['poll-without-c', 18], ['poll-without-c', 30]]);
  assert.deepEqual(decisions.at(-1)!.withdraw, [{ coordinate: C, action: 'delete' }]);
  assert.ok(!(C in state.events));
});

test('a withdrawn event that has RSVPs is republished as cancelled', () => {
  const { decisions } = run([['poll-full', 0], ['poll-without-c', 6], ['poll-without-c', 12], ['poll-without-c', 30]], new Set([C]));
  assert.deepEqual(decisions.at(-1)!.withdraw, [{ coordinate: C, action: 'cancel' }]);
});

test('a failed poll neither counts a miss nor resets one', () => {
  let state = run([['poll-full', 0], ['poll-without-c', 6], ['poll-without-c', 12]]).state;
  const failed = reconcilePoll(state, { at: NOW + 18 * HOUR, ok: false, seen: [] }, () => false);
  assert.deepEqual(failed.state, state);
  assert.deepEqual(failed.withdraw, []);
  state = failed.state;
  const third = reconcilePoll(state, { at: NOW + 30 * HOUR, ok: true, seen: poll('poll-without-c') }, () => false);
  assert.deepEqual(third.withdraw, [{ coordinate: C, action: 'delete' }]);
});

test('a poll that returns no events for a calendar that had some is quarantined', () => {
  const { decisions, state } = run([['poll-full', 0], ['poll-empty', 6], ['poll-empty', 12], ['poll-empty', 40]]);
  for (const decision of decisions.slice(1)) {
    assert.equal(decision.quarantine, 'empty');
    assert.deepEqual(decision.publish, []);
    assert.deepEqual(decision.withdraw, []);
  }
  assert.ok(B in state.events, 'quarantined polls count no misses');
});

test('a poll that drops more than half the upcoming events is quarantined', () => {
  const { decisions } = run([['poll-full', 0], ['poll-only-a', 6]]);
  assert.equal(decisions[1]!.quarantine, 'dropped-half');
  assert.deepEqual(decisions[1]!.publish, []);
});

test('a quarantine lifts when the feed recovers', () => {
  const { decisions } = run([['poll-full', 0], ['poll-only-a', 6], ['poll-full', 12]]);
  assert.equal(decisions[2]!.quarantine, null);
  assert.equal(decisions[2]!.publish.length, 5);
});

test('a quarantine held for 7 days is accepted, and misses count from then', () => {
  const { decisions } = run([['poll-full', 0], ['poll-only-a', 6], ['poll-only-a', 6 + 7 * 24], ['poll-only-a', 6 + 7 * 24 + 6], ['poll-only-a', 6 + 7 * 24 + 30]]);
  assert.equal(decisions[2]!.quarantine, null);
  assert.deepEqual(decisions[2]!.withdraw, []);
  assert.deepEqual(decisions[4]!.withdraw.map((w) => w.coordinate).sort(), [B, C, `31923:${nostrD('seq-d@fixture.eventindex.space')}`].sort());
});

test('past events are left alone, and forgotten once they leave the window', () => {
  const { decisions } = run([['poll-full', 0], ['poll-full', 6]]);
  const past = `31923:${nostrD('seq-past@fixture.eventindex.space')}`;
  assert.ok(decisions[1]!.publish.includes(past));
  // Seventy days on, every event has passed and the feed has dropped them all.
  const later = reconcilePoll(decisions[1]!.state, { at: NOW + 70 * 24 * HOUR, ok: true, seen: [] }, () => false);
  assert.equal(later.quarantine, null);
  assert.deepEqual(later.withdraw, []);
  assert.deepEqual(later.state.events, {});
});

test('an event that changes kind is withdrawn at its old address at once', () => {
  const uid = 'seq-a@fixture.eventindex.space';
  const timed: Seen = { coordinate: `31923:${nostrD(uid)}`, uid, recurring: false, start: NOW + 5 * 86400 };
  const allDay: Seen = { ...timed, coordinate: `31922:${nostrD(uid)}` };
  const first = reconcilePoll(emptyPresence(), { at: NOW, ok: true, seen: [timed] }, () => false);
  const second = reconcilePoll(first.state, { at: NOW + HOUR, ok: true, seen: [allDay] }, () => false);
  assert.deepEqual(second.withdraw, [{ coordinate: timed.coordinate, action: 'delete' }]);
  assert.deepEqual(second.publish, [allDay.coordinate]);
});

test('an occurrence dropped from a series follows the missing rule, not the change rule', () => {
  const uid = 'series@x';
  const one: Seen = { coordinate: '31923:aa', uid, recurring: true, start: NOW + 86400 };
  const two: Seen = { coordinate: '31923:bb', uid, recurring: true, start: NOW + 8 * 86400 };
  const three: Seen = { coordinate: '31923:cc', uid, recurring: true, start: NOW + 15 * 86400 };
  const first = reconcilePoll(emptyPresence(), { at: NOW, ok: true, seen: [one, two, three] }, () => false);
  const second = reconcilePoll(first.state, { at: NOW + HOUR, ok: true, seen: [one, three] }, () => false);
  assert.deepEqual(second.withdraw, []);
});

// Co-hosts, retimed series, and events removed shortly before they start

const seen = (coordinate: string, uid: string, start: number, recurring = false): Seen => ({ coordinate, uid, recurring, start });

test('an event that now yields to a co-host is deleted at once and counts toward no quarantine', () => {
  const day = 86400;
  const four = ['a', 'b', 'c', 'd'].map((x, i) => seen(`31923:${x}`, `${x}@x`, NOW + (i + 2) * day));
  const first = reconcilePoll(emptyPresence(), { at: NOW, ok: true, seen: four }, () => true);
  const second = reconcilePoll(first.state, { at: NOW + HOUR, ok: true, seen: [four[0]!], yielded: new Set(['31923:b', '31923:c', '31923:d']) }, () => true);
  assert.equal(second.quarantine, null);
  assert.deepEqual(second.withdraw, [
    { coordinate: '31923:b', action: 'delete' },
    { coordinate: '31923:c', action: 'delete' },
    { coordinate: '31923:d', action: 'delete' },
  ]);
});

test('a series whose time changes is not quarantined', () => {
  const day = 86400;
  const before = [1, 2, 3, 4].map((i) => seen(`31923:old${i}`, 'series@x', NOW + i * 7 * day, true));
  const after = [1, 2, 3, 4].map((i) => seen(`31923:new${i}`, 'series@x', NOW + i * 7 * day + HOUR, true));
  const first = reconcilePoll(emptyPresence(), { at: NOW, ok: true, seen: before }, () => false);
  const second = reconcilePoll(first.state, { at: NOW + HOUR, ok: true, seen: after }, () => false);
  assert.equal(second.quarantine, null);
  assert.deepEqual(second.publish.sort(), after.map((s) => s.coordinate).sort());
  assert.deepEqual(second.withdraw, []);
});

test('an event removed less than a day before it starts is withdrawn after two missed polls', () => {
  const x = seen('31923:x', 'x@x', NOW + 20 * HOUR);
  const keep = seen('31923:k', 'k@x', NOW + 5 * 86400);
  const first = reconcilePoll(emptyPresence(), { at: NOW, ok: true, seen: [x, keep] }, () => false);
  const second = reconcilePoll(first.state, { at: NOW + HOUR, ok: true, seen: [keep] }, () => false);
  assert.deepEqual(second.withdraw, []);
  const third = reconcilePoll(second.state, { at: NOW + 13 * HOUR, ok: true, seen: [keep] }, () => false);
  assert.deepEqual(third.withdraw, [{ coordinate: '31923:x', action: 'delete' }]);
});
