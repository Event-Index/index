// Properties from RFC 7986 and RFC 9073 read and write as their types say,
// so escaped text survives a feed, the stored record and the public .ics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { normalizeFeed, recordFromText } from '../src/normalize/normalize.ts';
import { identify } from '../src/directory/id.ts';
import { readFixture, feedUrlFor } from './helpers.ts';

const feed = (body: string) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'NAME:Food\\, Drink \; Fun', 'COLOR:dark\\,red',
  'BEGIN:VEVENT', 'UID:a@fixture.eventindex.space', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261020T180000Z', 'SUMMARY:Supper', body,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

test('an RFC 7986 calendar name is read unescaped', () => {
  const f = normalizeFeed(feed('DESCRIPTION:plain'), identify('https://fixture.eventindex.space/escaped.ics'));
  assert.equal(f.calendar.name, 'Food, Drink ; Fun');
});

test('a feed\'s STYLED-DESCRIPTION is read unescaped and written escaped', () => {
  const f = normalizeFeed(feed('STYLED-DESCRIPTION;FMTTYPE=text/html:<p>one\\, two</p>\\n<p>three</p>'), identify('https://fixture.eventindex.space/styled.ics'));
  const vevent = f.records[0]!.master!;
  assert.equal(vevent.getFirstPropertyValue('styled-description'), '<p>one, two</p>\n<p>three</p>');
  assert.match(vevent.toString(), /STYLED-DESCRIPTION;FMTTYPE=text\/html:<p>one\\, two<\/p>\\n<p>three<\/p>/);
});

test('a stored record with a multi-line STYLED-DESCRIPTION reads back whole', () => {
  const f = normalizeFeed(readFixture('meetup-pythonsd.ics'), identify(feedUrlFor('meetup-pythonsd.ics')));
  const record = f.records.find((r) => r.uid === 'event_312775793@meetup.com')!;
  const styled = String(record.master!.getFirstPropertyValue('styled-description'));
  assert.ok(styled.includes('\n'), 'the fixture\'s description has line breaks');
  const text = `${ICAL.stringify(record.component.toJSON())}\r\n`;
  assert.ok(text.split('\r\n').every((line) => line === '' || /^[A-Za-z-]+[;:]/.test(line) || line.startsWith(' ')), 'every line is a content line or a fold');
  const back = recordFromText(text, record.uid, record.id);
  assert.equal(back.master!.getFirstPropertyValue('styled-description'), styled);
  assert.equal(String(back.master!.getFirstPropertyValue('dtstart')), String(record.master!.getFirstPropertyValue('dtstart')));
});
