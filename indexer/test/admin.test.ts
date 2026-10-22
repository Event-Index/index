import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexDb } from '../src/store/index-db.ts';
import { eventPagesStore } from '../src/store/event-pages.ts';
import { directoryStore } from '../src/store/directory.ts';
import { queueStore } from '../src/store/queues.ts';
import { eventStore } from '../src/store/events.ts';
import { importSeeds, importCommunities, importGancio, importMobilizon, importAggregators, approveSubmission, rejectSubmission, approveRemoval, rejectRemoval, removeCalendar, approveClaim, rejectClaim, markAggregator, status, undoApproval, type Cities, type Communities, type GancioList, type MobilizonList } from '../src/service/admin.ts';
import { relayPauses } from '../src/service/publisher.ts';
import { discoveredStore } from '../src/store/discovered.ts';
import { identify } from '../src/directory/id.ts';
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
  s.dir.add({ d: `nostr:${'cd'.repeat(32)}`, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: null, description: null, image: null,
    location: null, g: null, foundVia: 'ingest', addedAt: NOW, mode: 'own', owner: 'cd'.repeat(32), listed: false });
  const report = status(s, NOW);
  assert.deepEqual(report, {
    indexPubkey: 'ab'.repeat(32), calendars: 2, aggregators: 0, removed: 0, unlisted: 1, stale: ['meetup:sdbitcoiners'], neverPolled: 2,
    upcomingEvents: 0, pendingSubmissions: 1, pendingRemovals: 1, pendingClaims: 0, lastDump: null,
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

test('the admin command keeps a calendar as summary and link, and lets it go back to its default', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const env = { ...process.env, EVENTINDEX_DATA_DIR: dataDir };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env, encoding: 'utf8' });
    const db = openIndexDb(join(dataDir, 'index.db'));
    const dir = directoryStore(db);
    dir.add({ d: 'meetup:pythonsd', role: 'calendar', source: 'meetup', feedUrl: 'https://www.meetup.com/pythonsd/events/ical/', pageUrl: null, name: 'SDPy', description: null, image: null, location: null, g: null, foundVia: 'maintainer', addedAt: NOW });
    db.close();
    const kept = run('content', 'meetup-pythonsd', 'summary');
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /summary and link/);
    const reopened = openIndexDb(join(dataDir, 'index.db'));
    assert.equal(directoryStore(reopened).contentReserved('meetup:pythonsd'), true);
    reopened.close();
    assert.equal(run('content', 'meetup:pythonsd', 'default').status, 0);
    const again = openIndexDb(join(dataDir, 'index.db'));
    assert.equal(directoryStore(again).contentReserved('meetup:pythonsd'), false);
    again.close();
    assert.equal(run('content', 'meetup-pythonsd', 'everything').status, 2);
    assert.equal(run('content', 'no-such-calendar', 'summary').status, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the Meetup page reader\'s state is shown, and a stop is cleared, by the admin command', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const env = { ...process.env, EVENTINDEX_DATA_DIR: dataDir };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env, encoding: 'utf8' });
    const db = openIndexDb(join(dataDir, 'index.db'));
    const pages = eventPagesStore(db);
    const feed = { location: null, status: null, stamp: '|' };
    pages.observe({ calendarD: 'meetup:g', uid: 'a', url: 'https://www.meetup.com/g/events/1/', start: 2_000_000_000, end: 2_000_003_600, feed });
    pages.observe({ calendarD: 'meetup:g', uid: 'b', url: 'https://www.meetup.com/g/events/2/', start: 2_000_000_000, end: 2_000_003_600, feed });
    pages.read('meetup:g', 'a', { stamp: '|', at: 1_900_000_000, outcome: 'read', facts: { location: 'Hall', cancelled: false } });
    pages.refused(5, null, 1_900_000_000);
    db.close();
    const shown = run('meetup-pages');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /stopped since 20\d\d-/);
    assert.match(shown.stdout, /read\s+1/);
    assert.match(shown.stdout, /not yet read\s+1/);
    assert.equal(run('meetup-pages', 'resume').status, 0);
    assert.match(run('meetup-pages').stdout, /reading/);
    const again = openIndexDb(join(dataDir, 'index.db'));
    assert.equal(eventPagesStore(again).state().stoppedAt, null);
    again.close();
    assert.equal(run('meetup-pages', 'frobnicate').status, 2);
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

const communities = JSON.parse(readFileSync(join(repo, 'seeds/communities.json'), 'utf8')) as Communities;

test('the hand-kept communities list names known cities and a way to read each one', () => {
  assert.ok(communities.communities.length >= 7);
  const slugs = new Set(cities.cities.map((c) => c.slug));
  for (const c of communities.communities) {
    assert.ok(c.name && slugs.has(c.city), `${c.name}: city ${c.city}`);
    assert.equal(c.found_via, 'hand-kept');
    if (c.source === 'nostr') assert.match(c.pubkey ?? '', /^[0-9a-f]{64}$/, c.name);
    else assert.ok(c.id || c.feed, c.name);
  }
});

test('importing the communities list files its feed calendars by their city, and only lists the native publishers', () => {
  const s = stores();
  const list: Communities = { communities: [
    { name: 'Bitcoin Park Nashville', city: 'nashville', source: 'meetup', id: 'bitcoinpark', found_via: 'hand-kept' },
    { name: 'PubKey', city: 'new-york', source: 'luma', id: 'cal-dlSUfDiWBlONmiQ', found_via: 'hand-kept' },
    { name: 'A Feed Club', city: 'austin', source: 'ics', feed: 'https://example.org/club.ics', found_via: 'hand-kept' },
    { name: 'Fork & Coin', city: 'chicago', source: 'nostr', pubkey: 'ab'.repeat(32), found_via: 'hand-kept' },
  ] };
  const report = importCommunities(s, list, cities, NOW);
  assert.deepEqual(report.filed.sort(), ['luma:cal-dlSUfDiWBlONmiQ', 'meetup:bitcoinpark', s.dir.list().find((e) => e.source === 'ics')!.d].sort());
  assert.deepEqual(report.native, ['Fork & Coin']);
  const park = s.dir.get('meetup:bitcoinpark')!;
  assert.equal(park.location, 'Nashville, US');
  assert.equal(park.g, 'dn6m');
  assert.equal(park.foundVia, 'hand-kept');
  assert.equal(s.dir.get('luma:cal-dlSUfDiWBlONmiQ')!.location, 'New York, US');
  assert.equal(s.dir.list().length, 3, 'no key is minted and nothing filed for a native publisher');
  const again = importCommunities(s, list, cities, NOW + 60);
  assert.deepEqual(again.filed, []);
  assert.equal(again.existing.length, 3);
});

test('importing the Gancio list files each instance as one community calendar, named for the instance, under the area given it', () => {
  const s = stores();
  const list: GancioList = { instances: [
    { host: 'bcn.convoca.la', name: 'Convoca-la BCN', feed: 'https://bcn.convoca.la/feed/ics', location: 'Barcelona, ES', g: 'sp3e' },
    { host: 'gancio.example.org', name: 'gancio.example.org', feed: 'https://gancio.example.org/feed/ics' },
    { host: 'gone.example.org', name: 'Gone', feed: 'https://gone.example.org/feed/ics', location: 'Worldwide', g: null },
  ], held: [{ host: 'held.example.org', reason: 'adult-themed; held pending a content-filter decision' }] };
  s.dir.block('gancio:gone.example.org', 'organizer request', NOW);
  const report = importGancio(s, list, NOW);
  assert.deepEqual(report, { filed: ['gancio:bcn.convoca.la', 'gancio:gancio.example.org'], existing: [], blocked: ['gancio:gone.example.org'] });
  const bcn = s.dir.get('gancio:bcn.convoca.la')!;
  assert.deepEqual([bcn.name, bcn.source, bcn.role, bcn.feedUrl, bcn.pageUrl, bcn.location, bcn.g, bcn.foundVia],
    ['Convoca-la BCN', 'gancio', 'calendar', 'https://bcn.convoca.la/feed/ics', 'https://bcn.convoca.la', 'Barcelona, ES', 'sp3e', 'gancio.org/instances']);
  const unplaced = s.dir.get('gancio:gancio.example.org')!;
  assert.deepEqual([unplaced.location, unplaced.g], [null, null]);
  assert.equal(s.dir.get('gancio:held.example.org'), null, 'a held instance is not filed');
  assert.deepEqual(importGancio(s, list, NOW + 60).existing, ['gancio:bcn.convoca.la', 'gancio:gancio.example.org']);
  assert.throws(() => importGancio(s, { instances: [{ host: 'x.example.org', name: 'X', feed: 'https://x.example.org/feed/ics?tags=a' }] }, NOW), /not a Gancio instance feed/);
});

test('importing the Mobilizon list files each group from its own instance, under the area it states', () => {
  const s = stores();
  const list: MobilizonList = { groups: [
    { instance: 'mobilizon.fr', group: 'lyontechhub', name: 'Lyon Tech Hub', feed: 'https://mobilizon.fr/@lyontechhub/feed/ics', location: 'Lyon, FR', g: 'u05k' },
    { instance: 'events.example.org', group: 'nowhere', name: 'No Address Group', feed: 'https://events.example.org/@nowhere/feed/ics', location: null, g: null },
  ] };
  const report = importMobilizon(s, list, NOW);
  assert.deepEqual(report, { filed: ['mobilizon:mobilizon.fr/@lyontechhub', 'mobilizon:events.example.org/@nowhere'], existing: [], blocked: [] });
  const lyon = s.dir.get('mobilizon:mobilizon.fr/@lyontechhub')!;
  assert.deepEqual([lyon.name, lyon.source, lyon.location, lyon.g, lyon.foundVia, lyon.pageUrl], ['Lyon Tech Hub', 'mobilizon', 'Lyon, FR', 'u05k', 'instances.mobilizon.org', 'https://mobilizon.fr/@lyontechhub']);
  assert.deepEqual([s.dir.get('mobilizon:events.example.org/@nowhere')!.location, s.dir.get('mobilizon:events.example.org/@nowhere')!.g], [null, null]);
  assert.equal(importMobilizon(s, list, NOW + 60).existing.length, 2);
  assert.throws(() => importMobilizon(s, { groups: [{ instance: 'other.example', group: 'lyontechhub', name: 'X', feed: 'https://mobilizon.fr/@lyontechhub/feed/ics', location: null, g: null }] }, NOW), /not its own instance/);
  assert.throws(() => importMobilizon(s, { groups: [{ instance: 'x.example', group: 'x', name: 'X', feed: 'https://x.example/feed/ics', location: null, g: null }] }, NOW), /not a Mobilizon group feed/);
});

test('the admin command imports a communities list like a seed list', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', 'import-seeds', 'seeds/communities.json'],
      { cwd: repo, env: { ...process.env, EVENTINDEX_DATA_DIR: dataDir }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^native publisher, not filed: Fork & Coin$/m);
    assert.match(run.stdout, /filed 6, already listed 0, on the do-not-index list 0/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('every city with a Luma Discover page names the page by its slug', () => {
  const withPage = cities.cities.filter((c) => c.luma_discover);
  assert.ok(withPage.length >= 16);
  for (const c of withPage) {
    assert.match(c.luma_discover!, /^luma:discplace-[A-Za-z0-9]+$/, c.slug);
    assert.match(c.luma_slug ?? '', /^[a-z0-9_-]+$/, c.slug);
  }
  assert.equal(new Set(withPage.map((c) => c.luma_slug)).size, withPage.length);
});

test('importing the aggregators files each Luma city page once, with its page and area, and no key', () => {
  const s = stores();
  const withPage = cities.cities.filter((c) => c.luma_discover);
  const report = importAggregators(s, cities, NOW);
  assert.equal(report.filed.length, withPage.length);
  const nyc = s.dir.get('luma:discplace-Izx1rQVSh8njYpP')!;
  assert.equal(nyc.role, 'aggregator');
  assert.equal(nyc.pageUrl, 'https://luma.com/nyc');
  assert.equal(nyc.feedUrl, 'https://api.luma.com/ics/get?entity=discover&id=discplace-Izx1rQVSh8njYpP');
  assert.equal(nyc.location, 'New York, US');
  assert.equal(nyc.foundVia, 'luma:discover');
  assert.equal(importAggregators(s, cities, NOW + 60).existing.length, withPage.length);
  assert.deepEqual(importAggregators(stores(), cities, NOW, ['nyc', 'austin']).filed.sort(),
    ['luma:discplace-Izx1rQVSh8njYpP', identify(`https://api.luma.com/ics/get?entity=discover&id=${cities.cities.find((c) => c.slug === 'austin')!.luma_discover!.slice(5)}`).d].sort());
  assert.throws(() => importAggregators(stores(), cities, NOW, ['nowhere']), /no city or Luma page nowhere/);
});

test('the admin command files the aggregators and lists what discovery did, skips with what the page showed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'indexer/src/admin.ts', ...args], { cwd: repo, env: { ...process.env, EVENTINDEX_DATA_DIR: dataDir }, encoding: 'utf8' });
    const filed = run('import-aggregators', '--only', 'nyc');
    assert.equal(filed.status, 0, filed.stderr);
    assert.match(filed.stdout, /^filed 1 aggregator, already listed 0, on the do-not-index list 0$/m);

    const now = Math.floor(Date.now() / 1000);
    const db = openIndexDb(join(dataDir, 'index.db'));
    const found = discoveredStore(db);
    const place = 'luma:discplace-Izx1rQVSh8njYpP';
    found.record({ d: 'luma:cal-Named0000000001', place, name: 'Design Meetup', status: 'filed', at: now - 60 });
    found.record({ d: 'luma:cal-Personal000001', place, name: 'Personal', status: 'skipped', reason: 'platform-default-calendar',
      detail: { event: 'Print exchange', url: 'https://luma.com/ev0', hosts: ['A Host', 'B Host'] }, at: now - 60 });
    found.record({ d: 'luma:cal-Waiting0000001', place, name: 'Waiting', status: 'candidate', at: now - 60 });
    found.record({ d: 'luma:cal-Old00000000001', place, name: 'Old', status: 'filed', at: now - 3 * 86400 });
    db.close();
    const listed = run('discoveries', '--hours', '24');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^New York \(luma:discplace-Izx1rQVSh8njYpP\): filed 1, skipped 1, refused 0, waiting 1$/m);
    assert.match(listed.stdout, /^ {2}filed\s+luma:cal-Named0000000001\s+Design Meetup$/m);
    assert.match(listed.stdout, /^ {2}skipped\s+luma:cal-Personal000001\s+Personal\s+platform-default-calendar\s+Print exchange\s+hosts: A Host, B Host\s+https:\/\/luma.com\/ev0$/m);
    assert.doesNotMatch(listed.stdout, /cal-Old/);
    assert.match(listed.stdout, /^in all: filed 1, skipped 1 \(1 platform default, 0 not public\), refused 0, waiting 1$/m);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('approving a native calendar files it as its organizer\'s, in the city they named', () => {
  const s = stores();
  const pubkey = 'a0'.repeat(32);
  const queued = s.queues.submit({ d: `nostr:${pubkey}`, feedUrl: '', source: 'nostr', role: 'calendar', name: 'Lakeside Bitcoin Club', city: 'chicago', at: NOW }, 10);
  const { d } = approveSubmission(s, (queued as { id: number }).id, {}, cities, NOW);
  const entry = s.dir.get(d)!;
  assert.deepEqual([entry.d, entry.mode, entry.owner, entry.source, entry.feedUrl], [`nostr:${pubkey}`, 'own', pubkey, 'nostr', '']);
  assert.equal(entry.location, 'Chicago, US');
  assert.equal(entry.name, 'Lakeside Bitcoin Club');
});

test('a claim is approved only once its organizer has shown control of the calendar', () => {
  const s = stores();
  importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  const { id } = s.queues.requestClaim({ d: 'meetup:pythonsd', pubkey: 'a0'.repeat(32), mode: 'own', signer: null, at: NOW });
  assert.throws(() => approveClaim(s, id, NOW), /not shown control/);
  s.queues.markClaimVerified(id, 'token', null, NOW + 60);
  approveClaim(s, id, NOW + 120);
  assert.equal(s.queues.claim(id)!.status, 'approved');
  assert.throws(() => approveClaim(s, id, NOW + 180), /not pending/);
  const other = s.queues.requestClaim({ d: 'meetup:pythonsd', pubkey: 'b0'.repeat(32), mode: 'own', signer: null, at: NOW });
  rejectClaim(s, other.id, NOW + 200);
  assert.equal(s.queues.claim(other.id)!.status, 'rejected');
});

test('a key that publishes a calendar itself owns no other; one the index publishes as may have several', () => {
  const s = stores();
  importSeeds(s, [seedFile('meetup/san-diego.json')], cities, NOW);
  const key = 'a0'.repeat(32);
  const native = s.queues.submit({ d: `nostr:${key}`, feedUrl: '', source: 'nostr', role: 'calendar', name: 'Lakeside', at: NOW }, 10) as { id: number };
  const own = s.queues.requestClaim({ d: 'meetup:pythonsd', pubkey: key, mode: 'own', signer: null, at: NOW });
  s.queues.markClaimVerified(own.id, 'token', null, NOW);
  approveClaim(s, own.id, NOW);
  s.dir.setOwnership('meetup:pythonsd', { mode: 'own', owner: key, claimedAt: NOW, nativeCalendar: null });
  assert.throws(() => approveSubmission(s, native.id, {}, cities, NOW), /already publishes/);
  const delegated = s.queues.requestClaim({ d: 'meetup:sdbitcoiners', pubkey: key, mode: 'delegated', signer: null, at: NOW });
  s.queues.markClaimVerified(delegated.id, 'token', null, NOW);
  assert.throws(() => approveClaim(s, delegated.id, NOW), /already publishes/);
  s.dir.retire('meetup:pythonsd', 'organizer request', NOW);
  approveClaim(s, delegated.id, NOW);
  assert.equal(s.queues.claim(delegated.id)!.status, 'approved', 'a removed calendar does not count');
});

test('a maintainer marks a listed nostr publisher as an aggregator', () => {
  const s = stores();
  const key = 'c0'.repeat(32);
  s.dir.add({ d: `nostr:${key}`, role: 'calendar', source: 'nostr', feedUrl: '', pageUrl: null, name: 'Bitcoin Events Worldwide', description: null, image: null,
    location: null, g: null, foundVia: 'ingest', addedAt: NOW, mode: 'own', owner: key });
  markAggregator(s, key);
  assert.equal(s.dir.get(`nostr:${key}`)!.role, 'aggregator');
  assert.throws(() => markAggregator(s, 'd0'.repeat(32)), /not listed/);
});
