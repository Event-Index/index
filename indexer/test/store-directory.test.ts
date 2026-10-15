import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openIndexDb } from '../src/store/index-db.ts';
import { directoryStore, type Entry } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore, type EventRow } from '../src/store/events.ts';
import { makeDump } from '../src/store/dump.ts';

const NOW = 1_792_000_000;
const entry = (d: string, extra: Partial<Entry> = {}): Entry => ({
  d, role: 'calendar', source: 'meetup', feedUrl: `https://www.meetup.com/${d.split(':')[1]}/events/ical/`, pageUrl: null,
  name: null, description: null, image: null, location: null, g: null, foundVia: null, addedAt: NOW, ...extra,
});

test('directory entries are added once, found by d, feed URL, local name and key, and retired with a reason', () => {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  assert.equal(dir.add(entry('meetup:pythonsd', { location: 'San Diego, US', g: '9mud' })), true);
  assert.equal(dir.add(entry('meetup:pythonsd')), false, 'already listed');
  dir.setKey('meetup:pythonsd', 'c1'.repeat(32));
  dir.setMeta('meetup:pythonsd', { name: 'San Diego Python Users Group', description: null, url: 'https://www.meetup.com/pythonsd/', image: null });
  const found = dir.get('meetup:pythonsd')!;
  assert.equal(found.name, 'San Diego Python Users Group');
  assert.equal(found.pubkey, 'c1'.repeat(32));
  assert.equal(found.localName, 'meetup-pythonsd');
  assert.equal(dir.byFeedUrl('https://www.meetup.com/pythonsd/events/ical/')!.d, 'meetup:pythonsd');
  assert.equal(dir.byLocalName('meetup-pythonsd')!.d, 'meetup:pythonsd');
  assert.equal(dir.byPubkey('c1'.repeat(32))!.d, 'meetup:pythonsd');
  assert.deepEqual(dir.list().map((e) => e.d), ['meetup:pythonsd']);
  dir.retire('meetup:pythonsd', 'organizer request', NOW + 10);
  assert.equal(dir.get('meetup:pythonsd')!.removed, 'organizer request');
  assert.deepEqual(dir.list().map((e) => e.d), [], 'retired entries are not listed');
  assert.deepEqual(dir.list({ includeRemoved: true }).map((e) => e.d), ['meetup:pythonsd']);
  assert.equal(dir.doNotIndex('meetup:pythonsd'), true);
  assert.equal(dir.add(entry('meetup:pythonsd')), false, 'a do-not-index d cannot come back');
});

test('directory search matches name, description and location, and an area by geohash prefix', () => {
  const db = openIndexDb(':memory:');
  const dir = directoryStore(db);
  dir.add(entry('meetup:pythonsd', { location: 'San Diego, US', g: '9mudz' }));
  dir.setMeta('meetup:pythonsd', { name: 'San Diego Python Users Group', description: 'Python study groups', url: null, image: null });
  dir.add(entry('meetup:dallas', { location: 'Dallas, US', g: '9vg4' }));
  dir.setMeta('meetup:dallas', { name: 'Dallas Bitcoiners', description: null, url: null, image: null });
  assert.deepEqual(dir.search({ q: 'python' }).map((e) => e.d), ['meetup:pythonsd']);
  assert.deepEqual(dir.search({ q: 'dallas' }).map((e) => e.d), ['meetup:dallas']);
  assert.deepEqual(dir.search({ near: '9mu' }).map((e) => e.d), ['meetup:pythonsd']);
  assert.equal(dir.search({ q: 'x%' }).length, 0, 'LIKE wildcards are matched literally');
});

test('the index keeps its own facts in meta', () => {
  const dir = directoryStore(openIndexDb(':memory:'));
  dir.setFact('index_pubkey', 'e1'.repeat(32));
  assert.equal(dir.fact('index_pubkey'), 'e1'.repeat(32));
  assert.equal(dir.fact('missing'), null);
});

test('submissions queue once per d, and the queue has a cap', () => {
  const q = queueStore(openIndexDb(':memory:'));
  assert.deepEqual(q.submit({ d: 'ics:a', feedUrl: 'https://a.example/f.ics', source: 'ics', role: 'calendar', name: 'A', at: NOW }, 2), { status: 'queued', id: 1 });
  assert.deepEqual(q.submit({ d: 'ics:a', feedUrl: 'https://a.example/f.ics', source: 'ics', role: 'calendar', name: 'A', at: NOW }, 2), { status: 'already-queued', id: 1 });
  q.submit({ d: 'ics:b', feedUrl: 'https://b.example/f.ics', source: 'ics', role: 'calendar', name: 'B', at: NOW }, 2);
  assert.deepEqual(q.submit({ d: 'ics:c', feedUrl: 'https://c.example/f.ics', source: 'ics', role: 'calendar', name: 'C', at: NOW }, 2), { status: 'queue-full' });
  assert.deepEqual(q.submissions('pending').map((s) => s.d), ['ics:a', 'ics:b']);
  q.resolveSubmission(1, 'approved', NOW + 1);
  assert.deepEqual(q.submissions('approved').map((s) => s.d), ['ics:a']);
});

test('a remove request gets a token, can be verified, and is resolved once', () => {
  const q = queueStore(openIndexDb(':memory:'));
  const { id, token } = q.requestRemoval({ d: 'meetup:pythonsd', message: 'We run this group.', at: NOW });
  assert.match(token, /^eventindex-remove-[a-z2-7]{10}$/);
  assert.equal(q.removals('pending')[0]!.d, 'meetup:pythonsd');
  q.markVerified(id, NOW + 5);
  assert.equal(q.removals('pending')[0]!.verifiedAt, NOW + 5);
  q.resolveRemoval(id, 'approved', NOW + 6);
  assert.deepEqual(q.removals('pending'), []);
  assert.equal(q.removals('approved')[0]!.id, id);
  q.resolveRemoval(id, 'done', NOW + 7);
  assert.equal(q.removals('done')[0]!.resolvedAt, NOW + 7);
});

const row = (id: string, start: number, extra: Partial<EventRow> = {}): EventRow => ({
  id, calendarD: 'meetup:pythonsd', recordId: 'r1', uid: `${id}@x`, d: `d-${id}`, kind: 31923, start, end: start + 3600, tzid: 'America/Los_Angeles',
  title: `Event ${id}`, summary: 'Monthly meetup', location: 'Qualcomm', g: '9mudzzzzz', tags: ['python'], url: null,
  cancelled: false, canonical: null, cohosts: [], ...extra,
});

test('a calendar\'s events are replaced as a whole, and queried by calendar, time, term, area and tag', () => {
  const db = openIndexDb(':memory:');
  const ev = eventStore(db);
  ev.replaceCalendar('meetup:pythonsd', [row('a', NOW + 100), row('b', NOW + 200, { title: 'Study group', tags: ['study'] })]);
  ev.replaceCalendar('meetup:pythonsd', [row('a', NOW + 100), row('c', NOW + 300, { title: 'Lightning talks', g: null, tags: ['talks'] })]);
  assert.deepEqual(ev.byCalendar('meetup:pythonsd', NOW, NOW + 1000).map((e) => e.id), ['a', 'c']);
  assert.equal(ev.byId('b'), null);
  assert.deepEqual(ev.search({ q: 'lightning', from: NOW, to: NOW + 1000 }).map((e) => e.id), ['c']);
  assert.deepEqual(ev.search({ near: '9mud', from: NOW, to: NOW + 1000 }).map((e) => e.id), ['a']);
  // An event without coordinates is near its calendar's area.
  directoryStore(db).add({ ...entry('meetup:pythonsd'), g: '9mud' });
  assert.deepEqual(ev.search({ near: '9mudq', from: NOW, to: NOW + 1000 }).map((e) => e.id), ['c']);
  assert.deepEqual(ev.search({ near: '9mu', from: NOW, to: NOW + 1000 }).map((e) => e.id), ['a', 'c']);
  assert.deepEqual(ev.search({ tag: 'python', from: NOW, to: NOW + 1000 }).map((e) => e.id), ['a']);
  assert.equal(ev.countUpcoming(NOW), 2);
});

test('the dump holds the directory, calendar metadata and poll statistics, and no event content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dump-'));
  try {
    const db = openIndexDb(join(dir, 'index.db'));
    directoryStore(db).add(entry('meetup:pythonsd'));
    db.savePollState('meetup:pythonsd', { etag: '"x"', lastModified: null, failures: 0, firstFailureAt: null, lastSuccessAt: NOW, nextPollAt: NOW + 3600, stale: false });
    db.putRecord({ calendarD: 'meetup:pythonsd', uid: 'u', id: 'i', ics: 'BEGIN:VCALENDAR', now: NOW });
    eventStore(db).replaceCalendar('meetup:pythonsd', [row('a', NOW)]);
    queueStore(db).requestRemoval({ d: 'meetup:pythonsd', message: 'private note', at: NOW });
    const out = join(dir, 'dump.db');
    makeDump(db, out, NOW);
    const dump = new Database(out, { readonly: true });
    const tables = dump.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => (t as { name: string }).name);
    assert.deepEqual(tables, ['about', 'calendars', 'poll_stats']);
    assert.equal((dump.prepare('SELECT d FROM calendars').get() as { d: string }).d, 'meetup:pythonsd');
    const stats = dump.prepare('SELECT * FROM poll_stats').get() as Record<string, unknown>;
    assert.equal(stats['last_success_at'], NOW);
    assert.ok(!('etag' in stats));
    dump.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
