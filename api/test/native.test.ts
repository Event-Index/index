// A native calendar through the API: its organizer's own events, served as
// records like any other calendar's.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { harness, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await harness({ native: true }); });
after(() => h.close());

const API = '/api/1.0';
const json = async (path: string) => {
  const response = await h.get(path);
  return { status: response.status, body: await response.json() as any };
};

test('a native calendar\'s entry names its organizer\'s key and calendar, and no feed', async () => {
  const native = h.native!;
  const name = h.dir.get(native.d)!.localName;
  const { status, body } = await json(`${API}/calendars/byslug/${name}`);
  assert.equal(status, 200);
  assert.equal(body.calendar.source, 'nostr');
  assert.equal(body.calendar.feed, null);
  assert.equal(body.calendar.name, 'Lakeside Bitcoin Club');
  assert.equal(body.eventindex.publishing, 'organizer');
  assert.equal(body.eventindex.nostr.npub, npubEncode(native.pubkey));
  assert.equal(body.eventindex.nostr.nip05, null, 'the index names no key it does not hold');
  const calendar = decode(body.eventindex.nostr.calendar);
  assert.deepEqual([calendar.type, (calendar.data as any).pubkey, (calendar.data as any).identifier], ['naddr', native.pubkey, 'main']);
  assert.equal(body.eventindex.event_count, 2);
  assert.equal(body.eventindex.claimed, false);
  assert.equal((await json(`${API}/calendars/byguid/${npubEncode(native.pubkey)}`)).body.calendar.d, native.d);
});

test('a native calendar\'s events point at the organizer\'s own events', async () => {
  const native = h.native!;
  const name = h.dir.get(native.d)!.localName;
  const { body } = await json(`${API}/events/bycalendar/${name}`);
  assert.equal(body.count, 2);
  const october = body.events.find((e: any) => JSON.stringify(e.jcal).includes('October meetup'));
  assert.equal(october.eventindex.source, 'nostr');
  const address = decode(october.eventindex.nostr);
  assert.deepEqual([(address.data as any).pubkey, (address.data as any).identifier, (address.data as any).kind], [native.pubkey, 'oct', 31923]);
  const ics = await (await h.get(`${API}/events/byid/${october.eventindex.id}.ics`)).text();
  const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!;
  assert.equal(vevent.getFirstPropertyValue('summary'), 'October meetup');
  assert.equal(vevent.getFirstPropertyValue('description'), 'Monthly meetup. Bring a friend.');
  assert.equal(vevent.getFirstProperty('dtstart')!.getParameter('tzid'), 'America/Chicago');
});

test('NIP-05 names only the keys the index holds', async () => {
  const name = h.dir.get(h.native!.d)!.localName;
  assert.deepEqual((await json(`/.well-known/nostr.json?name=${name}`)).body, { names: {} });
});

test('a native calendar\'s past events stay served, however long ago', async () => {
  const native = h.native!;
  const long = native.sign(31923, [['d', 'spring'], ['title', 'Spring meetup'], ['start', String(h.clock.now - 200 * 86400)]]);
  h.relay.get('ws://native.test')!.push(long);
  h.db.savePollState(native.d, { ...h.db.pollState(native.d), nextPollAt: 0 });
  await h.indexer.tick();
  const { body } = await json(`${API}/events/bycalendar/${h.dir.get(native.d)!.localName}?from=${h.clock.now - 365 * 86400}`);
  const spring = body.events.find((e: any) => JSON.stringify(e.jcal).includes('Spring meetup'));
  assert.ok(spring, 'listed');
  assert.equal((await h.get(`${API}/events/byid/${spring.eventindex.id}.ics`)).status, 200);
});
