import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { canonicalZone, bundledTimezone, vtimezoneFor, registerZones } from '../src/ical/zones.ts';
import { readFixture } from './helpers.ts';

test('canonicalZone resolves IANA names, aliases and vendor prefixes', () => {
  assert.equal(canonicalZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(canonicalZone('US/Pacific'), 'America/Los_Angeles');
  assert.equal(canonicalZone('Asia/Calcutta'), 'Asia/Kolkata');
  assert.equal(canonicalZone('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  assert.equal(canonicalZone('/softwarestudio.org/Olson_20011030_5/America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(canonicalZone('UTC'), 'Etc/UTC');
});

test('canonicalZone returns null for names that are not IANA zones', () => {
  assert.equal(canonicalZone('Eastern Standard Time'), null);
  assert.equal(canonicalZone(''), null);
  assert.equal(canonicalZone('Not/AZone'), null);
});

test('vtimezoneFor names the component after the TZID it stands for', () => {
  const component = vtimezoneFor('US/Pacific');
  assert.ok(component);
  assert.equal(component.getFirstPropertyValue('tzid'), 'US/Pacific');
  assert.equal(vtimezoneFor('Eastern Standard Time'), null);
});

// The bundled zone data must agree with the platform's tzdb for the
// projection window, or every converted time in that zone is wrong.
test('bundled zones agree with Intl offsets across the projection window', () => {
  const zones = [
    'America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Mexico_City',
    'America/Bogota', 'Europe/London', 'Europe/Paris', 'Europe/Istanbul', 'Europe/Moscow',
    'Africa/Lagos', 'Africa/Cairo', 'Africa/Johannesburg', 'Asia/Tokyo', 'Asia/Kolkata',
    'Asia/Shanghai', 'Asia/Jakarta', 'Asia/Tehran', 'Australia/Sydney', 'Pacific/Auckland',
    'America/St_Johns',
  ];
  const start = Date.UTC(2026, 8, 15);
  for (const tzid of zones) {
    const zone = bundledTimezone(tzid);
    assert.ok(zone, tzid);
    for (let day = 0; day <= 395; day += 7) {
      const instant = start + day * 86_400_000;
      const time = ICAL.Time.fromJSDate(new Date(instant), true);
      const icalOffset: number = zone.utcOffset(time);
      assert.equal(icalOffset, intlOffsetSeconds(tzid, instant), `${tzid} at ${new Date(instant).toISOString()}`);
    }
  }
});

test('registerZones lets a TZID without VTIMEZONE resolve to the right instant', () => {
  const calendar = new ICAL.Component(ICAL.parse(readFixture('mobilizon-lyontechhub.ics')));
  const report = registerZones(calendar);
  assert.deepEqual(report.unknown, []);
  assert.equal(report.resolved.get('Europe/Paris'), 'Europe/Paris');
  const event = calendar.getFirstSubcomponent('vevent')!;
  const start = event.getFirstPropertyValue('dtstart') as ICAL.Time;
  // 2026-10-15 19:00 in Paris (CEST, +02:00)
  assert.equal(start.toUnixTime(), Date.UTC(2026, 9, 15, 17, 0) / 1000);
});

test('registerZones leaves a feed VTIMEZONE in charge of its own TZID', () => {
  const calendar = new ICAL.Component(ICAL.parse(readFixture('meetup-pythonsd.ics')));
  const report = registerZones(calendar);
  assert.equal(report.resolved.get('America/Los_Angeles'), 'America/Los_Angeles');
  assert.deepEqual(report.fromFeed, ['America/Los_Angeles']);
  const event = calendar.getFirstSubcomponent('vevent')!;
  const start = event.getFirstPropertyValue('dtstart') as ICAL.Time;
  // 2026-10-17 10:00 in Los Angeles (PDT, -07:00)
  assert.equal(start.toUnixTime(), Date.UTC(2026, 9, 17, 17, 0) / 1000);
});

test('registerZones reports a TZID it cannot resolve', () => {
  const calendar = new ICAL.Component(ICAL.parse(readFixture('synthetic/tzid-without-vtimezone.ics')));
  const report = registerZones(calendar);
  assert.deepEqual(report.unknown, ['Eastern Standard Time']);
  assert.equal(report.resolved.get('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  assert.equal(report.resolved.get('US/Pacific'), 'America/Los_Angeles');
});

function intlOffsetSeconds(tzid: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'longOffset' }).formatToParts(new Date(instant));
  const name = parts.find((p) => p.type === 'timeZoneName')!.value; // "GMT+05:30" or "GMT"
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name)!;
  if (!match[1]) return 0;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === '-' ? -seconds : seconds;
}
