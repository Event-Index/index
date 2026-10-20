import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed, type NormalizedFeed } from '../src/normalize/normalize.ts';
import { openIndexDb, type IndexDb } from '../src/store/index-db.ts';
import { projectFeed, cohostPlan, type Planned, type ProjectorInput } from '../src/project/projector.ts';
import { identify } from '../src/directory/id.ts';
import { nostrD } from '../src/project/ids.ts';
import { readFixture, feedUrlFor, NOW } from './helpers.ts';

const INDEX = 'e1'.repeat(32);
const KEYS: Record<string, string> = {
  'luma:cal-BvuRd9eaZnDGBwy': 'c1'.repeat(32),
  'luma:cal-f6iLyfD3TN5qUO2': 'c2'.repeat(32),
};
const keyOf = (d: string) => KEYS[d] ?? 'c9'.repeat(32);
const H = 3600;

function feed(fixture: string, text = readFixture(fixture)): NormalizedFeed {
  return normalizeFeed(text, identify(feedUrlFor(fixture)));
}

// As the index projects a calendar it publishes as its organizer (B2).
const HOME = 'wss://home.example.org';
function run(f: NormalizedFeed, db: IndexDb, now = NOW, extra: Partial<ProjectorInput> = {}) {
  return projectFeed({
    feed: f, calendarPubkey: keyOf(f.context.d), indexPubkey: INDEX, keyOf, db, now, hasRsvps: () => false, plan: cohostPlan([f], NOW),
    delegated: { relay: HOME, calendarD: f.context.d }, ...extra,
  });
}

const kinds = (planned: Planned[]) => planned.map((p) => p.template.kind);
const tag = (p: Planned, name: string) => p.template.tags.find((t) => t[0] === name);

test('a first poll publishes the organizer\'s calendar and every event in the window, and no profile or relay list of theirs', () => {
  const db = openIndexDb(':memory:');
  const result = run(feed('luma-calendar-craftnook.ics'), db);
  assert.deepEqual(kinds(result.publish).sort(), [31923, 31923, 31923, 31923, 31924]);
  assert.equal(result.quarantine, null);
  const calendar = result.publish.find((p) => p.template.kind === 31924)!;
  assert.equal(calendar.template.tags.filter((t) => t[0] === 'a').length, 4);
});

test('a second identical poll publishes nothing', () => {
  const db = openIndexDb(':memory:');
  const f = feed('luma-calendar-craftnook.ics');
  for (const p of run(f, db).publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}-1` });
  assert.deepEqual(run(f, db, NOW + H).publish, []);
});

test('a changed event is republished later than its last version', () => {
  const db = openIndexDb(':memory:');
  for (const p of run(feed('luma-calendar-craftnook.ics'), db).publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}-1` });
  const edited = feed('luma-calendar-craftnook.ics', readFixture('luma-calendar-craftnook.ics').replace('SUMMARY:craftyween party', 'SUMMARY:craftyween party (sold out)'));
  const second = run(edited, db, NOW);
  assert.equal(second.publish.length, 1);
  assert.deepEqual(tag(second.publish[0]!, 'title'), ['title', 'craftyween party (sold out)']);
  assert.ok(second.publish[0]!.template.created_at > db.lastCreatedAt(KEYS['luma:cal-BvuRd9eaZnDGBwy']!, 31923, nostrD('evt-PDzqdd9OU1nQXYz@events.lu.ma'))!);
});

test('an aggregator publishes nothing', () => {
  const db = openIndexDb(':memory:');
  assert.deepEqual(run(feed('luma-city-nyc.ics'), db).publish, []);
});

test('a co-hosted event is published once, by the signing calendar, naming the co-host', () => {
  const craftnook = feed('luma-calendar-craftnook.ics');
  const journaling = feed('luma-calendar-journaling.ics');
  const plan = cohostPlan([craftnook, journaling], NOW);
  const db = openIndexDb(':memory:');
  const signed = run(craftnook, db, NOW, { plan }).publish.filter((p) => p.template.kind === 31923);
  const shared = signed.find((p) => tag(p, 'd')![1] === nostrD('evt-ILpIInTRKRV1pnY@events.lu.ma'))!;
  assert.deepEqual(shared.template.tags.filter((t) => t[0] === 'p').map((t) => t[1]), [KEYS['luma:cal-BvuRd9eaZnDGBwy'], KEYS['luma:cal-f6iLyfD3TN5qUO2']]);
  const other = run(journaling, db, NOW, { plan }).publish;
  assert.ok(!other.some((p) => p.template.kind === 31923 && tag(p, 'd')![1] === nostrD('evt-ILpIInTRKRV1pnY@events.lu.ma')));
  const calendar = other.find((p) => p.template.kind === 31924)!;
  assert.ok(calendar.template.tags.some((t) => t[0] === 'a' && t[1] === `31923:${KEYS['luma:cal-BvuRd9eaZnDGBwy']}:${nostrD('evt-ILpIInTRKRV1pnY@events.lu.ma')}`), 'a co-host lists the event in its calendar');
});

test('a vanished event is deleted with every version and its address', () => {
  const db = openIndexDb(':memory:');
  const full = normalizeFeed(readFixture('sequences/poll-full.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const withoutC = normalizeFeed(readFixture('sequences/poll-without-c.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const commit = (r: ReturnType<typeof run>, n: number) => {
    for (const p of r.publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}-${n}` });
    db.savePresence(full.context.d, r.presence);
  };
  commit(run(full, db, NOW), 1);
  for (const [i, hours] of [6, 12, 18].entries()) commit(run(withoutC, db, NOW + hours * H), i + 2);
  const last = run(withoutC, db, NOW + 30 * H);
  const deletion = last.publish.find((p) => p.template.kind === 5)!;
  const c = nostrD('seq-c@fixture.eventindex.space');
  assert.deepEqual(deletion.template.tags, [['e', `id-${c}-1`], ['a', `31923:${keyOf(full.context.d)}:${c}`], ['k', '31923']]);
  assert.equal(last.withdrawn[0]!.status, 'deleted');
});

test('a vanished event with RSVPs is republished as cancelled', () => {
  const db = openIndexDb(':memory:');
  const full = normalizeFeed(readFixture('sequences/poll-full.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const withoutC = normalizeFeed(readFixture('sequences/poll-without-c.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const rsvps = { hasRsvps: () => true };
  const commit = (r: ReturnType<typeof run>) => {
    for (const p of r.publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}` });
    db.savePresence(full.context.d, r.presence);
  };
  commit(run(full, db, NOW, rsvps));
  for (const hours of [6, 12, 18]) commit(run(withoutC, db, NOW + hours * H, rsvps));
  const last = run(withoutC, db, NOW + 30 * H, rsvps);
  const cancelled = last.publish.find((p) => p.template.kind === 31923)!;
  assert.deepEqual(tag(cancelled, 'title'), ['title', 'Cancelled: Choir practice']);
  assert.equal(last.withdrawn[0]!.status, 'cancelled');
});

test('a quarantined poll publishes nothing', () => {
  const db = openIndexDb(':memory:');
  const f = normalizeFeed(readFixture('sequences/poll-full.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const first = run(f, db, NOW);
  for (const p of first.publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}` });
  db.savePresence(f.context.d, first.presence);
  const empty = normalizeFeed(readFixture('sequences/poll-empty.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const second = run(empty, db, NOW + 6 * H);
  assert.equal(second.quarantine, 'empty');
  assert.deepEqual(second.publish, []);
});

test('a bulk publish spreads created_at', () => {
  const db = openIndexDb(':memory:');
  const result = run(feed('google-kubernetes-sig-cli.ics'), db, NOW, { perSecond: 10 });
  const events = result.publish.filter((p) => p.template.kind === 31923);
  assert.equal(events.length, 26);
  const perSecond = new Map<number, number>();
  for (const p of result.publish) perSecond.set(p.template.created_at, (perSecond.get(p.template.created_at) ?? 0) + 1);
  assert.ok([...perSecond.values()].every((n) => n <= 10));
});

test('a calendar whose events now yield to a co-host deletes its copies, without quarantine', () => {
  // Ten days before the shared event of 15 September, so it is upcoming.
  const early = Date.UTC(2026, 8, 5, 18) / 1000;
  const db = openIndexDb(':memory:');
  const journaling = feed('luma-calendar-journaling.ics');
  const craftnook = feed('luma-calendar-craftnook.ics');
  const alone = run(journaling, db, early, { plan: cohostPlan([journaling], early) });
  for (const p of alone.publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}` });
  db.savePresence(journaling.context.d, alone.presence);
  const shared = nostrD('evt-ILpIInTRKRV1pnY@events.lu.ma');
  assert.ok(alone.publish.some((p) => p.record.d === shared));
  const joined = run(journaling, db, early + H, { plan: cohostPlan([craftnook, journaling], early + H), hasRsvps: () => true });
  assert.equal(joined.quarantine, null);
  const deletion = joined.publish.find((p) => p.template.kind === 5)!;
  assert.ok(deletion.template.tags.some((t) => t[0] === 'a' && t[1] === `31923:${keyOf(journaling.context.d)}:${shared}`));
  assert.deepEqual(joined.withdrawn.map((w) => w.status), ['deleted']);
  assert.ok(joined.log.some((l) => /^yield evt-ILpIInTRKRV1pnY@events\.lu\.ma to luma:cal-BvuRd9eaZnDGBwy: copy deleted, with RSVPs$/.test(l)), joined.log.join('\n'));
});

test('a deletion is recorded as withdrawn only once it is published', () => {
  const db = openIndexDb(':memory:');
  const full = normalizeFeed(readFixture('sequences/poll-full.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const withoutC = normalizeFeed(readFixture('sequences/poll-without-c.ics'), identify('https://fixture.eventindex.space/neighborhood.ics'));
  const commit = (r: ReturnType<typeof run>) => {
    for (const p of r.publish) db.markPublished({ ...p.record, eventId: `id-${p.record.d}` });
    db.savePresence(full.context.d, r.presence);
  };
  commit(run(full, db, NOW));
  for (const hours of [6, 12, 18]) commit(run(withoutC, db, NOW + hours * H));
  run(withoutC, db, NOW + 30 * H);
  assert.equal(db.projection(keyOf(full.context.d), 31923, nostrD('seq-c@fixture.eventindex.space'))!.status, 'live');
});

test('a co-host whose copy has no title does not take the event from the others', () => {
  const event = (summary: string | null) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:shared@x', 'DTSTAMP:20261015T120000Z',
    'DTSTART:20261028T180000Z', ...(summary ? [`SUMMARY:${summary}`] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const ids = ['https://a.example/feed.ics', 'https://b.example/feed.ics'].map(identify).sort((x, y) => (x.d < y.d ? -1 : 1));
  const lower = normalizeFeed(event(null), ids[0]!);
  const higher = normalizeFeed(event('Shared event'), ids[1]!);
  const plan = cohostPlan([lower, higher], NOW);
  const db = openIndexDb(':memory:');
  const published = run(higher, db, NOW, { plan }).publish.filter((p) => p.template.kind === 31923);
  assert.equal(published.length, 1);
});
