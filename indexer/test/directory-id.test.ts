import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identify, canonicalFeedUrl, localName } from '../src/directory/id.ts';

test('a Luma calendar is identified by its calendar id, whatever the domain', () => {
  for (const url of [
    'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy',
    'https://api.lu.ma/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy',
    'webcal://api.lu.ma/ics/get?id=cal-BvuRd9eaZnDGBwy&entity=calendar',
    'HTTPS://API.LUMA.COM:443/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy#x',
  ]) {
    const id = identify(url);
    assert.equal(id.d, 'luma:cal-BvuRd9eaZnDGBwy', url);
    assert.equal(id.source, 'luma');
    assert.equal(id.role, 'calendar');
    assert.equal(id.feedUrl, 'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy');
    assert.equal(id.pageUrl, 'https://luma.com/calendar/cal-BvuRd9eaZnDGBwy');
  }
});

test('a Luma Discover feed is an aggregator', () => {
  const id = identify('https://api.luma.com/ics/get?entity=discover&id=discplace-Izx1rQVSh8njYpP');
  assert.equal(id.d, 'luma:discplace-Izx1rQVSh8njYpP');
  assert.equal(id.role, 'aggregator');
  assert.equal(id.pageUrl, null);
});

test('a Luma feed of another kind is refused', () => {
  assert.throws(() => identify('https://api.luma.com/ics/get?entity=user&id=usr-abc'), /unsupported-feed/);
});

test('a Meetup group is identified by its urlname', () => {
  const id = identify('webcal://www.meetup.com/PythonSD/events/ical/');
  assert.equal(id.d, 'meetup:pythonsd');
  assert.equal(id.source, 'meetup');
  assert.equal(id.feedUrl, 'https://www.meetup.com/PythonSD/events/ical/');
  assert.equal(id.pageUrl, 'https://www.meetup.com/PythonSD/');
  assert.equal(identify('https://meetup.com/pythonsd/events/ical').d, 'meetup:pythonsd');
});

test('a Mobilizon group is identified by instance and group', () => {
  const id = identify('https://mobilizon.fr/@lyontechhub/feed/ics');
  assert.equal(id.d, 'mobilizon:mobilizon.fr/@lyontechhub');
  assert.equal(id.source, 'mobilizon');
  assert.equal(id.pageUrl, 'https://mobilizon.fr/@lyontechhub');
});

test('a public Google calendar is identified by its calendar id', () => {
  const id = identify('https://calendar.google.com/calendar/ical/calendar%40kubernetes.io/public/basic.ics');
  assert.equal(id.d, 'google:calendar@kubernetes.io');
  assert.equal(id.source, 'google');
  assert.equal(id.feedUrl, 'https://calendar.google.com/calendar/ical/calendar%40kubernetes.io/public/basic.ics');
  assert.equal(id.pageUrl, 'https://calendar.google.com/calendar/embed?src=calendar%40kubernetes.io');
});

test('any other feed is identified by the hash of its canonical URL', () => {
  const id = identify('webcal://Example.org:443/events.ics?b=2&a=1#frag');
  assert.equal(id.feedUrl, 'https://example.org/events.ics?b=2&a=1');
  assert.equal(id.d, `ics:${createHash('sha256').update('https://example.org/events.ics?b=2&a=1').digest('hex')}`);
  assert.equal(id.source, 'ics');
  assert.equal(id.role, 'calendar');
});

test('canonicalFeedUrl keeps http for unknown hosts and drops default ports', () => {
  assert.equal(canonicalFeedUrl('http://example.org:80/a.ics'), 'http://example.org/a.ics');
  assert.equal(canonicalFeedUrl(' https://example.org/a.ics? '), 'https://example.org/a.ics');
});

test('identify rejects what is not an http(s) or webcal URL', () => {
  assert.throws(() => identify('ftp://example.org/a.ics'), /invalid-url/);
  assert.throws(() => identify('not a url'), /invalid-url/);
});

test('localName maps a directory d to NIP-05 characters', () => {
  assert.equal(localName('luma:cal-BvuRd9eaZnDGBwy'), 'luma-cal-bvurd9eazndgbwy');
  assert.equal(localName('meetup:pythonsd'), 'meetup-pythonsd');
  assert.equal(localName('mobilizon:mobilizon.fr/@lyontechhub'), 'mobilizon-mobilizon-fr-lyontechhub');
  assert.equal(localName('google:calendar@kubernetes.io'), 'google-calendar-kubernetes-io');
  assert.equal(localName('google:j7gov1cmnqr9tvg14k621j7t5c@group.calendar.google.com'), 'google-j7gov1cmnqr9tvg14k621j7t5c');
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(localName(`ics:${hex}`), 'ics-a1b2c3d4e5f60718');
});

test('localName stays within NIP-05 characters and 64 characters', () => {
  for (const d of ['mobilizon:a-very-long-instance-name.example.org/@an-even-longer-group-name-that-keeps-going', 'meetup:Ünïcode_Group']) {
    const name = localName(d);
    assert.match(name, /^[a-z0-9._-]{1,64}$/, name);
    assert.equal(localName(d), name);
  }
});

test('identify refuses a Google URL with broken percent-encoding', () => {
  assert.throws(() => identify('https://calendar.google.com/calendar/ical/%E0%A4%A/public/basic.ics'), /invalid-url/);
});
