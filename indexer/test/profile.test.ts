import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarProfile, relayList, calendarList, deletionFor, GENERAL_RELAYS, CALENDAR_LIST_MAX } from '../src/project/profile.ts';
import { INDEX_RELAY } from '../src/project/nip52.ts';
import { adapterFor } from '../src/adapters/index.ts';
import { naddrEncode, npubEncode } from 'nostr-tools/nip19';

const CAL = 'c1'.repeat(32);
const OTHER = 'c2'.repeat(32);
const NOW = Date.UTC(2026, 9, 15, 18) / 1000;

function luma(state: 'mirrored' | 'removed' = 'mirrored') {
  return calendarProfile({
    name: 'welcome to the craftnook',
    url: 'https://luma.com/calendar/cal-BvuRd9eaZnDGBwy',
    image: 'https://images.lumacdn.com/avatar.png',
    source: 'luma',
    localName: 'luma-cal-bvurd9eazndgbwy',
    policy: adapterFor('luma').policy,
    state,
  });
}

test('kind 0 names the calendar and says it is a mirror and where to act', () => {
  const event = luma();
  assert.equal(event.kind, 0);
  const content = JSON.parse(event.content);
  assert.equal(content.name, 'welcome to the craftnook');
  assert.equal(content.about, 'Events of welcome to the craftnook, mirrored from Luma by Event Index, which is not affiliated with Luma. Organizer? You can claim this calendar or have it removed: https://eventindex.space/calendar/luma-cal-bvurd9eazndgbwy.');
  assert.equal(content.nip05, 'luma-cal-bvurd9eazndgbwy@eventindex.space');
  assert.equal(content.website, 'https://luma.com/calendar/cal-BvuRd9eaZnDGBwy');
});

test('kind 0 carries a picture only where the source policy allows images', () => {
  assert.equal(JSON.parse(luma().content).picture, undefined);
  const open = calendarProfile({ name: 'Rich Calendar', url: null, image: 'https://example.org/logo.png', source: 'ics', localName: 'ics-0011223344556677', policy: adapterFor('ics').policy, state: 'mirrored' });
  const content = JSON.parse(open.content);
  assert.equal(content.picture, 'https://example.org/logo.png');
  assert.equal(content.website, undefined);
  assert.equal(content.about, 'Events of Rich Calendar, mirrored from its calendar feed by Event Index. Organizer? You can claim this calendar or have it removed: https://eventindex.space/calendar/ics-0011223344556677.');
});

test('kind 0 styles each platform as its owner does, and says the index is not affiliated with it', () => {
  const about = (source: 'meetup' | 'mobilizon' | 'google' | 'gancio') => JSON.parse(calendarProfile({ name: 'X', url: null, image: null, source, localName: 'x', policy: adapterFor(source).policy, state: 'mirrored' }).content).about;
  assert.equal(about('meetup'), 'Events of X, mirrored from Meetup® by Event Index, which is not affiliated with Meetup. Organizer? You can claim this calendar or have it removed: https://eventindex.space/calendar/x.');
  assert.match(about('mobilizon'), /mirrored from Mobilizon by Event Index, which is not affiliated with Mobilizon\./);
  assert.match(about('google'), /mirrored from Google Calendar by Event Index, which is not affiliated with Google\./);
  assert.match(about('gancio'), /mirrored from Gancio by Event Index, which is not affiliated with Gancio\./);
});

test('a removed calendar\'s kind 0 says so', () => {
  assert.equal(JSON.parse(luma('removed').content).about, 'No longer mirrored by Event Index at its organizer\'s request.');
});

test('kind 10002 names the index relay unmarked and the general relays it publishes to for writing', () => {
  const event = relayList(GENERAL_RELAYS);
  assert.equal(event.kind, 10002);
  assert.deepEqual(event.tags, [['r', INDEX_RELAY], ...GENERAL_RELAYS.map((r) => ['r', r, 'write'])]);
  assert.deepEqual(relayList().tags, [['r', INDEX_RELAY]], 'no general relay while publishing to none');
});

test('kind 31924 lists upcoming and recent events, signed or co-hosted, soonest first', () => {
  const event = calendarList({
    name: 'welcome to the craftnook',
    description: null,
    now: NOW,
    items: [
      { coordinate: `31923:${CAL}:b`, start: NOW + 7200 },
      { coordinate: `31923:${OTHER}:co`, start: NOW + 3600 },
      { coordinate: `31922:${CAL}:recent`, start: NOW - 10 * 86400 },
      { coordinate: `31923:${CAL}:old`, start: NOW - 31 * 86400 },
    ],
  });
  assert.equal(event.kind, 31924);
  assert.equal(event.content, '');
  assert.deepEqual(event.tags, [
    ['d', 'calendar'],
    ['title', 'welcome to the craftnook'],
    ['a', `31922:${CAL}:recent`, INDEX_RELAY],
    ['a', `31923:${OTHER}:co`, INDEX_RELAY],
    ['a', `31923:${CAL}:b`, INDEX_RELAY],
  ]);
});

test('kind 31924 stays within a relay\'s default event size', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ coordinate: `31923:${CAL}:${'f'.repeat(56)}${String(i).padStart(8, '0')}`, start: NOW + i * 60 }));
  const event = calendarList({ name: 'Big', description: 'd'.repeat(2000), now: NOW, items });
  assert.equal(event.tags.filter((t) => t[0] === 'a').length, CALENDAR_LIST_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...event, id: 'x'.repeat(64), pubkey: CAL, sig: 'x'.repeat(128), created_at: NOW })) < 65_536);
});

test('a deletion names every version, the address and the kind', () => {
  const event = deletionFor({ versions: ['aa'.repeat(32), 'bb'.repeat(32)], coordinate: `31923:${CAL}:d1`, kind: 31923 });
  assert.equal(event.kind, 5);
  assert.deepEqual(event.tags, [['e', 'aa'.repeat(32)], ['e', 'bb'.repeat(32)], ['a', `31923:${CAL}:d1`], ['k', '31923']]);
});

test('a claimed calendar key\'s kind 0 and calendar say where the calendar now publishes', () => {
  const owner = 'a0'.repeat(32);
  const profile = JSON.parse(calendarProfile({
    name: 'welcome to the craftnook', url: 'https://luma.com/calendar/cal-BvuRd9eaZnDGBwy', image: null, source: 'luma', localName: 'luma-cal-bvurd9eazndgbwy',
    policy: adapterFor('luma').policy, state: 'claimed', owner,
  }).content);
  assert.equal(profile.about, `This calendar now publishes as ${npubEncode(owner)}.`);
  assert.equal(profile.name, 'welcome to the craftnook');
  const calendar = calendarList({ name: 'welcome to the craftnook', description: 'Crafts.', now: NOW, items: [], owner, ownerCalendar: `31924:${owner}:main`, ownerRelay: 'wss://home.example.org' });
  assert.equal(calendar.content, `This calendar now publishes as ${npubEncode(owner)}. nostr:${naddrEncode({ kind: 31924, pubkey: owner, identifier: 'main', relays: ['wss://home.example.org'] })}`);
  assert.equal(calendarList({ name: 'x', description: null, now: NOW, items: [], owner }).content, `This calendar now publishes as ${npubEncode(owner)}. nostr:${npubEncode(owner)}`);
});

test('a calendar published as its organizer keeps its own d and names their relay', () => {
  const event = calendarList({ name: 'x', description: null, now: NOW, items: [{ coordinate: `31923:${CAL}:b`, start: NOW + 60 }], d: 'meetup:pythonsd', relay: 'wss://home.example.org' });
  assert.deepEqual(event.tags, [['d', 'meetup:pythonsd'], ['title', 'x'], ['a', `31923:${CAL}:b`, 'wss://home.example.org']]);
});
