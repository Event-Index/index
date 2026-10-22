import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeed, type NormalizedFeed, type EventRecord } from '../src/normalize/normalize.ts';
import { adapterFor } from '../src/adapters/index.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor } from './helpers.ts';

function normalize(fixture: string, text = readFixture(fixture)): NormalizedFeed {
  return normalizeFeed(text, identify(feedUrlFor(fixture)));
}

function record(feed: NormalizedFeed, uid: string): EventRecord {
  const found = feed.records.find((r) => r.uid === uid);
  assert.ok(found, `no record for ${uid}`);
  return found;
}

// Luma

test('Luma: the first DESCRIPTION line is the event URL and leaves the description', () => {
  const event = record(normalize('luma-city-nyc.ics'), 'evt-8obJGsASb0HxSiX@events.lu.ma').master!;
  assert.equal(event.getFirstPropertyValue('url'), 'https://luma.com/pi1ww9st');
  const description = String(event.getFirstPropertyValue('description'));
  assert.ok(description.startsWith('Address:\nNewlab\nBrooklyn, NY'), description.slice(0, 40));
  assert.ok(!description.includes('Get up-to-date information'));
});

test('Luma: SEQUENCE and STATUS:TENTATIVE are dropped', () => {
  const event = record(normalize('luma-calendar-craftnook.ics'), 'evt-PDzqdd9OU1nQXYz@events.lu.ma').master!;
  assert.ok(!event.hasProperty('sequence'));
  assert.ok(!event.hasProperty('status'));
});

test('Luma: STATUS:CANCELLED is kept', () => {
  const text = readFixture('luma-calendar-craftnook.ics').replace(
    /(UID:evt-PDzqdd9OU1nQXYz@events\.lu\.ma[\s\S]*?)STATUS:TENTATIVE/,
    '$1STATUS:CANCELLED',
  );
  const event = record(normalize('luma-calendar-craftnook.ics', text), 'evt-PDzqdd9OU1nQXYz@events.lu.ma').master!;
  assert.equal(event.getFirstPropertyValue('status'), 'CANCELLED');
});

test('Luma: a hidden venue keeps no place: no event-page LOCATION and no GEO, and is marked', () => {
  const hidden = record(normalize('luma-calendar-craftnook.ics'), 'evt-BY6CUfvAuCM89l4@events.lu.ma').master!;
  assert.ok(!hidden.hasProperty('location'));
  assert.ok(!hidden.hasProperty('geo'), 'what the organizer hid is not stored');
  assert.equal(hidden.getFirstPropertyValue('x-eventindex-venue'), 'hidden');
  const city = record(normalize('luma-city-nyc.ics'), 'evt-7h9SGiYxFEGPhAu@events.lu.ma').master!;
  assert.ok(!city.hasProperty('geo') && !city.hasProperty('location'));
  const open = record(normalize('luma-calendar-craftnook.ics'), 'evt-PDzqdd9OU1nQXYz@events.lu.ma').master!;
  assert.ok(!open.hasProperty('x-eventindex-venue'));
  assert.ok(open.hasProperty('location'));
});

test('Luma: "Personal" and "Luma Calendar" are platform defaults, so the name comes from the organizer', () => {
  const feed = normalize('luma-personal-newlab.ics');
  assert.equal(feed.calendar.platformDefault, true);
  assert.equal(feed.calendar.name, 'Newlab Brooklyn');
  assert.equal(feed.calendar.nameSource, 'ORGANIZER');
  assert.equal(feed.calendar.description, null);
  assert.equal(normalize('luma-calendar-craftnook.ics').calendar.platformDefault, false);
});

test('Luma: the organizer name "Luma Event" is a platform default', () => {
  assert.equal(adapterFor('luma').isDefaultOrganizerName!('Luma Event'), true);
  assert.equal(adapterFor('luma').isDefaultOrganizerName!('Newlab Brooklyn'), false);
});

test('Luma: the summary leaves out the address block and the hosts line', () => {
  const luma = adapterFor('luma');
  assert.equal(luma.summaryText!('Address:\nharicot vert\'s dreamworld\nKings County, NY\nUnited States\n\nHosted by craftnook & Journaling Studio'), '');
  assert.equal(
    luma.summaryText!('Address:\nNewlab\nBrooklyn, NY\nUnited States\n\nUnleash your inner artist!\n\nHosted by Newlab Brooklyn'),
    'Unleash your inner artist!',
  );
});

test('every source but an organizer\'s own nostr events keeps full descriptions and images out of public projections by default', () => {
  for (const source of ['luma', 'meetup', 'mobilizon', 'gancio', 'google', 'ics'] as const) {
    assert.deepEqual(adapterFor(source).policy, { fullDescription: false, images: false }, source);
  }
  assert.deepEqual(adapterFor('nostr').policy, { fullDescription: true, images: true });
});

// Meetup

test('Meetup: URL and the feed VTIMEZONE are kept, the group-name first line is not', () => {
  const r = record(normalize('meetup-pythonsd.ics'), 'event_312775793@meetup.com');
  const event = r.master!;
  assert.equal(event.getFirstPropertyValue('url'), 'https://www.meetup.com/pythonsd/events/312775793/');
  const description = String(event.getFirstPropertyValue('description'));
  assert.ok(description.startsWith('We will be at Qualcomm Building Q'), description.slice(0, 40));
});

test('Meetup: a Markdown description moves to STYLED-DESCRIPTION', () => {
  const event = record(normalize('meetup-pythonsd.ics'), 'event_312775793@meetup.com').master!;
  const styled = event.getFirstProperty('styled-description')!;
  assert.equal(styled.getParameter('fmttype'), 'text/markdown');
  assert.ok(String(styled.getFirstValue()).includes('**GETTING INTO THE VENUE**'));
  const plain = String(event.getFirstPropertyValue('description'));
  assert.ok(plain.includes('GETTING INTO THE VENUE') && !plain.includes('**'));
  assert.ok(plain.includes('YouTube channel (https://www.youtube.com/@sandiegopython)'));
});

// Mobilizon

test('Mobilizon: a plain-text ORGANIZER is read as the organizer name', () => {
  const feed = normalize('mobilizon-lyontechhub.ics');
  assert.equal(feed.calendar.name, 'Lyon Tech Hub');
});

test('Mobilizon: an empty LOCATION is dropped and an image ATTACH kept', () => {
  const event = record(normalize('mobilizon-lyontechhub.ics'), 'ef6c676c-2ade-4e5a-85c9-9af55b530295').master!;
  assert.ok(!event.hasProperty('location'));
  const attach = event.getFirstProperty('attach')!;
  assert.equal(attach.getParameter('fmttype'), 'image/jpeg');
});

test('Mobilizon: Markdown escapes do not reach the plain description', () => {
  const event = record(normalize('mobilizon-lyontechhub.ics'), 'c93acabc-0885-40ca-b861-565079746ed2').master!;
  const plain = String(event.getFirstPropertyValue('description'));
  assert.ok(plain.includes('~20 personnes'), plain.slice(0, 300));
  assert.ok(!/\\[-~,]/.test(plain));
});

// Google

test('Google: a description holding one link gives the event its URL', () => {
  const event = record(normalize('google-python-events.ics'), '07f2d6e3-37e8-4fa8-9ea2-dd581b3bcb51').master!;
  assert.equal(event.getFirstPropertyValue('url'), 'http://pycon.fr/2026');
  const sigCli = record(normalize('google-kubernetes-sig-cli.ics'), '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com').master!;
  assert.ok(!sigCli.hasProperty('url'), 'two links: no URL is guessed');
});

test('Google: a non-image ATTACH is kept in the record', () => {
  const event = record(normalize('google-kubernetes-sig-cli.ics'), '0l893qetg1o0pmufr6bgki87jd_R20260930T160000@google.com').master!;
  assert.equal(event.getFirstProperty('attach')!.getParameter('fmttype'), 'application/vnd.google-apps.document');
});
