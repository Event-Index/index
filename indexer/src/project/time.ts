// Instants and dates from ical.js times, with floating times read in the
// calendar's zone (X-WR-TIMEZONE), else UTC.

import ICAL from 'ical.js';
import { bundledTimezone, canonicalZone } from '../ical/zones.ts';

export function isFloating(time: ICAL.Time): boolean {
  return !time.isDate && (!time.zone || time.zone.tzid === 'floating');
}

export function unix(time: ICAL.Time, floatingZone: string | null): number {
  if (time.isDate) return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  if (isFloating(time)) {
    const zone = floatingZone ? bundledTimezone(floatingZone) : null;
    if (!zone) return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) / 1000;
    const fields = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
    return new ICAL.Time(fields, zone).toUnixTime();
  }
  return time.toUnixTime();
}

// The IANA zone a time is written in. UTC and floating times take the
// calendar's zone when it has one.
export function tzidOf(time: ICAL.Time, calendarZone: string | null): string | null {
  if (time.isDate) return null;
  if (isFloating(time)) return calendarZone;
  const tzid = time.zone?.tzid;
  if (!tzid || tzid === 'UTC' || tzid === 'Z') return calendarZone;
  return canonicalZone(tzid);
}

export function dateString(time: ICAL.Time): string {
  return `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

// An occurrence's original start (its RECURRENCE-ID) as unix seconds in
// decimal, or YYYY-MM-DD for a date. It names the occurrence's `d`.
export function occurrenceKey(recurrenceId: ICAL.Time, floatingZone: string | null): string {
  return recurrenceId.isDate ? dateString(recurrenceId) : String(unix(recurrenceId, floatingZone));
}
