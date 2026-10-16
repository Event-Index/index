import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexDb } from '../src/store/index-db.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { importSeeds, approveSubmission, rejectSubmission, approveRemoval, rejectRemoval, removeCalendar, status, undoApproval, type Cities } from '../src/service/admin.ts';
import { relayPauses } from '../src/service/publisher.ts';
import type { Seed } from '../src/directory/seed.ts';
import { NOW } from './helpers.ts';

const repo = new URL('../../', import.meta.url).pathname;
const seedFile = (path: string) => JSON.parse(readFileSync(join(repo, 'seeds', path), 'utf8')) as Seed;
const cities = JSON.parse(readFileSync(join(repo, 'seeds/cities.json'), 'utf8')) as Cities;

function stores() {
  const db = openIndexDb(':memory:');
  return { db, dir: directoryStore(db), queues: queueStore(db), events: eventStore(db) };
}

test('import-seeds files each listed calendar with its city and where it was found, and nothing it skipped', () => {
  const s = stores();
  const report = importSeeds(s, [seedFile('meetup/san-diego.json'), seedFile('luma/san-diego.json')], cities, NOW);
  assert.equal(report.filed.length, 12);
  assert.deepEqual(report.existing, []);
  const pythonsd = s.dir.get('meetup:pythonsd')!;
  assert.equal(pythonsd.feedUrl, 'https://www.meetup.com/pythonsd/events/ical/');
  assert.equal(pythonsd.role, 'calendar');
  assert.equal(pythonsd.location, 'San Diego, US');
  assert.equal(pythonsd.g, '9mud');
  assert.equal(pythonsd.foundVia, 'maintainer');
  assert.equal(pythonsd.addedAt, NOW);
  assert.equal(s.dir.get('meetup:sdbitcoiners')!.foundVia, 'btcmap:san-diego-bitcoiners');
  assert.equal(s.dir.get('luma:cal-0OtjMfvBVQ47Eq5')!.foundVia, 'luma:discplace-MNBATdzid940kqJ', 'a reviewed item is filed, found through its list');
  assert.equal(s.dir.get('luma:cal-Oh4miyw9TnvVPx1'), null, 'a skipped calendar is not filed');
});

test('import-seeds is idempotent and never files a calendar on the do-not-index list', () => {
  const s = stores();
  s.dir.block('meetup:pythonsd', 'organizer request', NOW - 10);
  const first = importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  assert.deepEqual(first.filed, ['meetup:sdbitcoiners']);
  assert.deepEqual(first.blocked, ['meetup:pythonsd']);
  const again = importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW + 60);
  assert.deepEqual(again.filed, []);
  assert.deepEqual(again.existing, ['meetup:sdbitcoiners']);
  assert.equal(s.dir.get('meetup:sdbitcoiners')!.addedAt, NOW);
});

test('import-seeds refuses a seed list for a city cities.json does not list', () => {
  const s = stores();
  assert.throws(() => importSeeds(s, [{ ...seedFile('meetup/san-diego.json'), geonames_id: 1 }], cities, NOW), /no city with geonames id 1/);
});

test('approving a submission files it (with a city when given); rejecting one does not', () => {
  const s = stores();
  const one = s.queues.submit({ d: 'meetup:pythonsd', feedUrl: 'https://www.meetup.com/pythonsd/events/ical/', source: 'meetup', role: 'calendar', name: 'San Diego Python', at: NOW - 100 }, 100);
  const two = s.queues.submit({ d: 'meetup:other', feedUrl: 'https://www.meetup.com/other/events/ical/', source: 'meetup', role: 'calendar', name: null, at: NOW - 50 }, 100);
  assert.ok('id' in one && 'id' in two);
  const filed = approveSubmission(s, one.id, { city: 'san-diego' }, cities, NOW);
  assert.equal(filed.d, 'meetup:pythonsd');
  const entry = s.dir.get('meetup:pythonsd')!;
  assert.equal(entry.foundVia, 'submission');
  assert.equal(entry.name, 'San Diego Python');
  assert.equal(entry.location, 'San Diego, US');
  assert.equal(entry.g, '9mud');
  assert.equal(entry.pageUrl, 'https://www.meetup.com/pythonsd/');
  assert.equal(s.queues.submission(one.id)!.status, 'approved');
  rejectSubmission(s, two.id, NOW);
  assert.equal(s.queues.submission(two.id)!.status, 'rejected');
  assert.equal(s.dir.get('meetup:other'), null);
  assert.throws(() => approveSubmission(s, two.id, {}, cities, NOW), /not pending/);
});

test('a submission whose calendar went on the do-not-index list cannot be approved', () => {
  const s = stores();
  const sub = s.queues.submit({ d: 'meetup:pythonsd', feedUrl: 'https://www.meetup.com/pythonsd/events/ical/', source: 'meetup', role: 'calendar', name: null, at: NOW }, 100);
  assert.ok('id' in sub);
  s.dir.block('meetup:pythonsd', 'organizer request', NOW);
  assert.throws(() => approveSubmission(s, sub.id, {}, cities, NOW), /do-not-index/);
  assert.equal(s.queues.submission(sub.id)!.status, 'pending');
});

test('approving a remove request hands it to the poll service; rejecting one leaves the calendar listed', () => {
  const s = stores();
  importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  const a = s.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
  const b = s.queues.requestRemoval({ d: 'meetup:sdbitcoiners', message: 'not ours', at: NOW });
  approveRemoval(s, a.id, NOW);
  assert.equal(s.queues.removal(a.id)!.status, 'approved');
  rejectRemoval(s, b.id, NOW);
  assert.equal(s.queues.removal(b.id)!.status, 'rejected');
  assert.equal(s.dir.get('meetup:sdbitcoiners')!.removed, null);
  assert.throws(() => approveRemoval(s, b.id, NOW), /not pending/);
});

test('a maintainer can remove a calendar by its local name or d', () => {
  const s = stores();
  importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  const name = s.dir.get('meetup:pythonsd')!.localName;
  const request = removeCalendar(s, name, 'by email', NOW);
  assert.equal(s.queues.removal(request.id)!.status, 'approved');
  assert.equal(s.queues.removal(request.id)!.d, 'meetup:pythonsd');
  assert.throws(() => removeCalendar(s, 'no-such-calendar', null, NOW), /no calendar/);
});

test('status counts the directory, the queues and the stale feeds', () => {
  const s = stores();
  importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  s.queues.submit({ d: 'meetup:x', feedUrl: 'https://www.meetup.com/x/events/ical/', source: 'meetup', role: 'calendar', name: null, at: NOW }, 100);
  s.queues.requestRemoval({ d: 'meetup:pythonsd', message: null, at: NOW });
  s.db.savePollState('meetup:sdbitcoiners', { ...s.db.pollState('meetup:sdbitcoiners'), stale: true });
  s.dir.setFact('index_pubkey', 'ab'.repeat(32));
  const report = status(s, NOW);
  assert.deepEqual(report, {
    indexPubkey: 'ab'.repeat(32), calendars: 2, aggregators: 0, removed: 0, withKey: 0, stale: ['meetup:sdbitcoiners'], neverPolled: 2,
    upcomingEvents: 0, pendingSubmissions: 1, pendingRemovals: 1, lastDump: null,
  });
});

test('the admin command runs against the data directory without any key', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const env = { ...process.env, EVENTINDEX_DATA_DIR: dataDir };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env, encoding: 'utf8' });
    const imported = run('import-seeds', 'seeds/meetup/san-diego.json');
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /filed 2, already listed 0, on the do-not-index list 0/);
    const shown = run('status');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /calendars\s+2/);
    const unknown = run('frobnicate');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /usage/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('relay pauses are kept in index.db, listed, set and cleared by the admin command', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const env = { ...process.env, EVENTINDEX_DATA_DIR: dataDir };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.match(run('relays').stdout, /no relay is paused/);
    const paused = run('pause-relay', 'wss://relay.example', '--hours', '24');
    assert.equal(paused.status, 0, paused.stderr);
    const db = openIndexDb(join(dataDir, 'index.db'));
    const state = relayPauses(directoryStore(db)).get('wss://relay.example')!;
    assert.equal(state.strikes, 1);
    assert.ok(Math.abs(state.until! - (Math.floor(Date.now() / 1000) + 24 * 3600)) < 60);
    db.close();
    assert.match(run('relays').stdout, /wss:\/\/relay\.example\tpaused until 20\d\d-.*\t1 strike/);
    assert.equal(run('resume-relay', 'wss://relay.example').status, 0);
    assert.match(run('relays').stdout, /no relay is paused/);
    assert.equal(run('pause-relay', 'not-a-relay').status, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an approval by the index itself can be undone: the calendar is removed and kept out', () => {
  const s = stores();
  const sub = s.queues.submit({ d: 'meetup:spammy', feedUrl: 'https://www.meetup.com/spammy/events/ical/', source: 'meetup', role: 'calendar', name: 'Spammy', at: NOW }, 100);
  assert.ok('id' in sub);
  s.dir.add({ d: 'meetup:spammy', role: 'calendar', source: 'meetup', feedUrl: 'https://www.meetup.com/spammy/events/ical/', pageUrl: null, name: 'Spammy', description: null, image: null, location: null, g: null, foundVia: 'submission', addedAt: NOW });
  s.queues.resolveSubmission(sub.id, 'approved', NOW, 'auto');
  assert.deepEqual(s.queues.autoApproved().map((x) => x.d), ['meetup:spammy']);
  const removal = undoApproval(s, sub.id, NOW + 60);
  assert.equal(s.queues.removal(removal.id)!.status, 'approved', 'the poll service removes it on its next tick');
  assert.equal(s.queues.removal(removal.id)!.message, 'auto-approval undone');
  assert.equal(s.queues.submission(sub.id)!.status, 'undone');
  assert.throws(() => undoApproval(s, sub.id, NOW + 90), /not an approval by the index/);
  const manual = s.queues.submit({ d: 'meetup:fine', feedUrl: 'https://www.meetup.com/fine/events/ical/', source: 'meetup', role: 'calendar', name: null, at: NOW }, 100);
  assert.ok('id' in manual);
  approveSubmission(s, manual.id, {}, cities, NOW);
  assert.equal(s.queues.submission(manual.id)!.approvedBy, 'maintainer');
  assert.throws(() => undoApproval(s, manual.id, NOW), /not an approval by the index/);
});

test('the admin command lists the approvals the index made itself', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const db = openIndexDb(join(dataDir, 'index.db'));
    const q = queueStore(db);
    const sub = q.submit({ d: 'meetup:auto', feedUrl: 'https://www.meetup.com/auto/events/ical/', source: 'meetup', role: 'calendar', name: 'Auto Group', at: NOW }, 100);
    assert.ok('id' in sub);
    q.resolveSubmission(sub.id, 'approved', NOW, 'auto');
    db.close();
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env: { ...process.env, EVENTINDEX_DATA_DIR: dataDir }, encoding: 'utf8' });
    const listed = run('approvals');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^${sub.id}\\t\\S+\\tmeetup:auto\\tAuto Group\\thttps://www.meetup.com/auto/events/ical/$`, 'm'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
