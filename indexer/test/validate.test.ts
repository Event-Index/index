import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeedUrl, isPublicAddress, validateFeed, MAX_FEED_BYTES } from '../src/directory/validate.ts';
import { readFixture } from './helpers.ts';

test('public feed URLs are accepted', () => {
  for (const url of [
    'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy',
    'https://www.meetup.com/pythonsd/events/ical/',
    'https://calendar.google.com/calendar/ical/calendar%40kubernetes.io/public/basic.ics',
    'https://mobilizon.fr/@lyontechhub/feed/ics',
    'webcal://example.org/events.ics?lang=en',
  ]) {
    assert.deepEqual(checkFeedUrl(url), { ok: true }, url);
  }
});

test('private feed URLs are refused', () => {
  for (const url of [
    'https://calendar.google.com/calendar/ical/someone%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics',
    'https://example.org/feed.ics?token=abc123',
    'https://example.org/feed.ics?apiKey=abc123',
    'https://example.org/feed.ics?access_token=abc123',
    'https://www.meetup.com/pythonsd/events/ical/?sig=abcdef',
    'https://www.meetup.com/events/ical/12345678/0f1e2d3c4b5a/going',
    'https://mobilizon.fr/events/going/SFMyNTY.g2gDbQAAACQ/ics',
    'https://outlook.office365.com/owa/calendar/abc@example.org/0123abcd/calendar.ics',
    'webcal://p52-caldav.icloud.com/published/2/MTEyMzQ1Njc4OTExMjM0NTabcdef',
    'https://example.org/secret-8f7e6d5c4b3a/calendar.ics',
  ]) {
    assert.deepEqual(checkFeedUrl(url), { ok: false, reason: 'private-feed-url' }, url);
  }
});

test('what is not an http(s) or webcal URL is refused', () => {
  assert.deepEqual(checkFeedUrl('file:///etc/passwd'), { ok: false, reason: 'invalid-url' });
  assert.deepEqual(checkFeedUrl('https://user:pass@example.org/feed.ics'), { ok: false, reason: 'private-feed-url' });
});

test('private, loopback, link-local and special addresses are not public', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.5.4', '192.168.1.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::7f00:1', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress('not an ip'), false);
});

test('a feed must parse as iCalendar and hold an event or a calendar name', () => {
  assert.deepEqual(validateFeed(readFixture('meetup-pythonsd.ics')), { ok: true });
  assert.deepEqual(validateFeed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Quiet\r\nEND:VCALENDAR\r\n'), { ok: true });
  assert.deepEqual(validateFeed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'), { ok: false, reason: 'empty' });
  assert.deepEqual(validateFeed('<html>Not found</html>'), { ok: false, reason: 'not-icalendar' });
});

test('a feed over 5 MB is refused', () => {
  assert.equal(MAX_FEED_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(validateFeed('x'.repeat(MAX_FEED_BYTES + 1)), { ok: false, reason: 'too-large' });
});

test('a feed with one unparseable event still validates', () => {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:bad@x', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=XX', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:good@x', 'SUMMARY:Good', 'DTSTART:20261021T100000Z', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  assert.deepEqual(validateFeed(text), { ok: true });
});

test('IPv4-compatible, site-local, local-use NAT64, 6to4 and Teredo addresses are judged as not public', () => {
  for (const ip of ['::7f00:1', '::127.0.0.1', 'fec0::1', '64:ff9b:1::a00:1', '2002:7f00:1::1', '2002:0a00:0001::1', '2001::1', '2001:0:4136:e378::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('2002:0808:0808::1'), true, '6to4 of a public address');
});

test('a URL with broken percent-encoding is refused, not thrown', () => {
  assert.deepEqual(checkFeedUrl('https://example.org/%E0%A4%A/feed.ics'), { ok: false, reason: 'invalid-url' });
});
