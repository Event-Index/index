import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export function readFixture(path: string): string {
  return readFileSync(`${fixtures}feeds/${path}`, 'utf8');
}

export function readPage(path: string): string {
  return readFileSync(`${fixtures}pages/${path}`, 'utf8');
}

// The clock every fixture was captured against.
export const NOW = Date.UTC(2026, 9, 15, 18, 0, 0) / 1000;

const FEED_URLS: Record<string, string> = {
  'luma-calendar-craftnook.ics': 'https://api.luma.com/ics/get?entity=calendar&id=cal-BvuRd9eaZnDGBwy',
  'luma-calendar-journaling.ics': 'https://api.luma.com/ics/get?entity=calendar&id=cal-f6iLyfD3TN5qUO2',
  'luma-personal-newlab.ics': 'https://api.luma.com/ics/get?entity=calendar&id=cal-EpqkMBrIPXa045L',
  'luma-city-nyc.ics': 'https://api.luma.com/ics/get?entity=discover&id=discplace-Izx1rQVSh8njYpP',
  'meetup-pythonsd.ics': 'https://www.meetup.com/pythonsd/events/ical/',
  'mobilizon-lyontechhub.ics': 'https://mobilizon.fr/@lyontechhub/feed/ics',
  'google-python-events.ics': 'https://calendar.google.com/calendar/ical/j7gov1cmnqr9tvg14k621j7t5c%40group.calendar.google.com/public/basic.ics',
  'google-kubernetes-sig-cli.ics': 'https://calendar.google.com/calendar/ical/calendar%40kubernetes.io/public/basic.ics',
  'google-us-holidays.ics': 'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics',
};

// The feed URL a fixture was captured from (synthetic fixtures get a
// generic URL under the fixture host).
export function feedUrlFor(fixture: string): string {
  return FEED_URLS[fixture] ?? `https://fixture.eventindex.space/${fixture}`;
}
