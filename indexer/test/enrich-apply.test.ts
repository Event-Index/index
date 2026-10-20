import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { applyPage, feedSays, isMeetupEventPage } from '../src/enrich/apply.ts';

const PAGE = 'https://www.meetup.com/example-group/events/100000001/';
function vevent(extra = ''): ICAL.Component {
  const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event_100000001@meetup.com\r\nDTSTART:20261022T190000Z\r\nSUMMARY:Monthly Meetup\r\nURL;VALUE=URI:${PAGE}\r\nSEQUENCE:1\r\nLAST-MODIFIED:20261007T231535Z\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  return new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent('vevent')!;
}
const marker = (v: ICAL.Component) => {
  const p = v.getFirstProperty('x-eventindex-enriched');
  return p ? { from: p.getFirstValue(), properties: p.getParameter('x-eventindex-properties') } : null;
};

test('what the feed says of an event: its place, its status and its version', () => {
  assert.deepEqual(feedSays(vevent('STATUS:CONFIRMED\r\n')), { location: null, status: 'CONFIRMED', stamp: '2026-10-07T23:15:35Z|1' });
  assert.deepEqual(feedSays(vevent('LOCATION:Feed Hall\r\n')), { location: 'Feed Hall', status: null, stamp: '2026-10-07T23:15:35Z|1' });
  assert.equal(isMeetupEventPage(PAGE), true);
  assert.equal(isMeetupEventPage('https://www.meetup.com/example-group/events/ical/'), false);
  assert.equal(isMeetupEventPage('https://www.meetup.com/example-group/events/nqgrvtyjcqbhb/'), true);
  assert.equal(isMeetupEventPage('https://www.meetup.com/example-group/events/rss/'), false);
  assert.equal(isMeetupEventPage('https://evil.example/www.meetup.com/g/events/1/'), false);
});

test('the page\'s venue fills an event the feed gives no place, marked with where it came from', () => {
  const v = vevent('STATUS:CONFIRMED\r\n');
  const feed = feedSays(v);
  applyPage(v, feed, { location: 'Example Hall, 100 Example Way, San Diego, CA', cancelled: false }, PAGE);
  assert.equal(v.getFirstPropertyValue('location'), 'Example Hall, 100 Example Way, San Diego, CA');
  assert.equal(v.getFirstPropertyValue('status'), 'CONFIRMED');
  assert.deepEqual(marker(v), { from: PAGE, properties: 'LOCATION' });
  assert.equal(v.getFirstPropertyValue('geo'), null, 'no coordinates');
  // The record keeps its text: the marker survives a round trip.
  const again = new ICAL.Component(ICAL.parse(ICAL.stringify(new ICAL.Component(['vcalendar', [], [v.toJSON()]]).toJSON()))).getFirstSubcomponent('vevent')!;
  assert.deepEqual(marker(again), { from: PAGE, properties: 'LOCATION' });
});

test('a place the feed gives is kept; a cancellation on the page cancels the event', () => {
  const v = vevent('LOCATION:Feed Hall\r\nSTATUS:CONFIRMED\r\n');
  applyPage(v, feedSays(v), { location: 'Page Hall', cancelled: true }, PAGE);
  assert.equal(v.getFirstPropertyValue('location'), 'Feed Hall');
  assert.equal(v.getFirstPropertyValue('status'), 'CANCELLED');
  assert.deepEqual(marker(v), { from: PAGE, properties: 'STATUS' });
});

test('applying again follows the page: a new page replaces, a page with nothing undoes, back to what the feed said', () => {
  const v = vevent('STATUS:CONFIRMED\r\n');
  const feed = feedSays(v);
  applyPage(v, feed, { location: 'Old Hall', cancelled: true }, PAGE);
  applyPage(v, feed, { location: 'New Hall', cancelled: false }, PAGE);
  assert.equal(v.getAllProperties('location').length, 1);
  assert.equal(v.getFirstPropertyValue('location'), 'New Hall');
  assert.equal(v.getFirstPropertyValue('status'), 'CONFIRMED');
  assert.deepEqual(marker(v), { from: PAGE, properties: 'LOCATION' });
  applyPage(v, feed, null, PAGE);
  assert.equal(v.getFirstPropertyValue('location'), null);
  assert.equal(v.getFirstPropertyValue('status'), 'CONFIRMED');
  assert.equal(marker(v), null);
  const none = vevent();
  applyPage(none, feedSays(none), { location: null, cancelled: true }, PAGE);
  applyPage(none, feedSays(vevent()), { location: null, cancelled: false }, PAGE);
  assert.equal(none.getFirstPropertyValue('status'), null, 'a status the feed did not give is not invented');
});
