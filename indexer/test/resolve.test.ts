// Whatever link people paste: a calendar's, a group's or an event's page on
// a platform, a feed, or a nostr identity, resolved to what the index reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import { resolveLink } from '../src/directory/resolve.ts';
import type { FetchResult } from '../src/poller/fetch.ts';
import { readPage } from './helpers.ts';

const pages = (map: Record<string, string>) => {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<FetchResult> => {
    asked.push(url);
    const text = map[url];
    return text === undefined ? { status: 'error', code: 'http-404' } : { status: 'ok', text, etag: null, lastModified: null, finalUrl: url };
  };
  return { fetch, asked };
};
const none = pages({}).fetch;

test('Meetup: a group\'s page, its events page or an event\'s page is the group\'s feed', async () => {
  for (const link of ['https://www.meetup.com/ribitcoiners/', 'https://www.meetup.com/ribitcoiners/events/', 'meetup.com/ribitcoiners/events/312775793/?utm_source=x',
    'https://www.meetup.com/ribitcoiners/events/ical/', 'webcal://www.meetup.com/ribitcoiners/events/ical/']) {
    assert.deepEqual(await resolveLink(link, none), { kind: 'feed', url: 'https://www.meetup.com/ribitcoiners/events/ical/', what: 'Meetup group' }, link);
  }
  const refused = await resolveLink('https://www.meetup.com/find/?keywords=bitcoin', none);
  assert.equal(refused.kind, 'refused');
});

test('Luma: a calendar\'s address is its feed; a vanity page or an event\'s page is read once for its calendar', async () => {
  assert.deepEqual(await resolveLink('https://luma.com/calendar/cal-ntaub36zjjTvcnl', none),
    { kind: 'feed', url: 'https://api.luma.com/ics/get?entity=calendar&id=cal-ntaub36zjjTvcnl', what: 'Luma calendar' });
  const site = pages({ 'https://luma.com/propellerinc': readPage('luma-calendar-page.html'), 'https://luma.com/craftnook-5iza': readPage('luma-event-page.html') });
  assert.deepEqual(await resolveLink('https://lu.ma/propellerinc', site.fetch),
    { kind: 'feed', url: 'https://api.luma.com/ics/get?entity=calendar&id=cal-ntaub36zjjTvcnl', what: 'Luma calendar' });
  assert.deepEqual(await resolveLink('https://luma.com/craftnook-5iza?tk=abc', site.fetch),
    { kind: 'feed', url: 'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy', what: 'Luma calendar' });
  assert.deepEqual(site.asked, ['https://luma.com/propellerinc', 'https://luma.com/craftnook-5iza'], 'the page is read at its canonical address, without query');
  const missing = await resolveLink('https://luma.com/no-such-page', site.fetch);
  assert.deepEqual([missing.kind, (missing as { code: string }).code], ['refused', 'luma-page']);
});

test('Google Calendar: an embed or share link is the calendar\'s public feed; a private address is refused', async () => {
  const id = 'j7gov1cmnqr9tvg14k621j7t5c@group.calendar.google.com';
  const feed = `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
  assert.deepEqual(await resolveLink(`https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id)}&ctz=America%2FNew_York`, none), { kind: 'feed', url: feed, what: 'Google calendar' });
  const cid = Buffer.from(id).toString('base64').replace(/=+$/, '');
  assert.deepEqual(await resolveLink(`https://calendar.google.com/calendar/u/0?cid=${cid}`, none), { kind: 'feed', url: feed, what: 'Google calendar' });
  const secret = await resolveLink(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/private-0123456789abcdef/basic.ics`, none);
  assert.deepEqual([secret.kind, (secret as { code: string }).code], ['refused', 'private-feed-url']);
});

test('Mobilizon: a group\'s page is its feed', async () => {
  assert.deepEqual(await resolveLink('https://mobilizon.fr/@lyontechhub', none), { kind: 'feed', url: 'https://mobilizon.fr/@lyontechhub/feed/ics', what: 'Mobilizon group' });
  assert.deepEqual(await resolveLink('https://mobilizon.fr/@lyontechhub/events', none), { kind: 'feed', url: 'https://mobilizon.fr/@lyontechhub/feed/ics', what: 'Mobilizon group' });
});

test('nostr: an npub, an nprofile or a NIP-05 address is a publisher\'s key', async () => {
  const pubkey = getPublicKey(generateSecretKey());
  assert.deepEqual(await resolveLink(npubEncode(pubkey), none), { kind: 'nostr', pubkey, relays: [] });
  assert.deepEqual(await resolveLink(`nostr:${npubEncode(pubkey)}`, none), { kind: 'nostr', pubkey, relays: [] });
  assert.deepEqual(await resolveLink(nprofileEncode({ pubkey, relays: ['wss://relay.example.org'] }), none), { kind: 'nostr', pubkey, relays: ['wss://relay.example.org'] });
  const nip05 = pages({ 'https://lakeside.example.org/.well-known/nostr.json?name=events': JSON.stringify({ names: { events: pubkey }, relays: { [pubkey]: ['wss://home.example.org'] } }) });
  assert.deepEqual(await resolveLink('events@lakeside.example.org', nip05.fetch), { kind: 'nostr', pubkey, relays: ['wss://home.example.org'] });
  const unknown = await resolveLink('nobody@lakeside.example.org', nip05.fetch);
  assert.deepEqual([unknown.kind, (unknown as { code: string }).code], ['refused', 'nip05']);
});

test('anything else is taken as a feed address, as given', async () => {
  assert.deepEqual(await resolveLink('https://example.org/events.ics', none), { kind: 'feed', url: 'https://example.org/events.ics', what: 'calendar feed' });
  assert.deepEqual(await resolveLink('  example.org/calendar.ics ', none), { kind: 'feed', url: 'https://example.org/calendar.ics', what: 'calendar feed' });
  const nonsense = await resolveLink('not a link at all', none);
  assert.deepEqual([nonsense.kind, (nonsense as { code: string }).code], ['refused', 'invalid-url']);
});
