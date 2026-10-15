import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';

test('ical.js parses a minimal calendar', () => {
  const component = new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'));
  assert.equal(component.name, 'vcalendar');
  assert.equal(component.getFirstPropertyValue('version'), '2.0');
});
