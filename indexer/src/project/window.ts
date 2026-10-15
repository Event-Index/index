// Occurrences of a record inside the projection window, expanded with
// ical.js's own recurrence iterator. RECURRENCE-ID overrides replace their
// occurrence; the record keeps the master.

import ICAL from 'ical.js';
import type { EventRecord } from '../normalize/normalize.ts';
import { nostrD, publicEventId } from './ids.ts';
import { dateString, isFloating, occurrenceKey, tzidOf, unix } from './time.ts';

export const WINDOW_PAST = 30 * 86400;
export const WINDOW_AHEAD = 365 * 86400;
export const MAX_OCCURRENCES = 10_000;
const MAX_ITERATIONS = 100_000;

export interface Window {
  from: number;
  to: number;
}

export function projectionWindow(now: number): Window {
  return { from: now - WINDOW_PAST, to: now + WINDOW_AHEAD };
}

export interface Occurrence {
  record: EventRecord;
  // The VEVENT the occurrence's details come from (the master or an override).
  event: ICAL.Component;
  d: string;
  id: string;
  // The occurrence key of a recurring event's occurrence, else null.
  occurrence: string | null;
  allDay: boolean;
  start: number;
  // Exclusive end in unix seconds; null when the feed gives no end.
  end: number | null;
  // YYYY-MM-DD for all-day occurrences.
  startDate: string | null;
  endDate: string | null;
  startTzid: string | null;
  endTzid: string | null;
  floating: boolean;
  cancelled: boolean;
  // The occurrence's times as the feed wrote them, and its original start.
  startTime: ICAL.Time;
  endTime: ICAL.Time | null;
  recurrenceId: ICAL.Time | null;
}

export interface ExpandOptions {
  calendarD: string;
  // The zone floating times are read in (the calendar's X-WR-TIMEZONE).
  floatingZone?: string | null;
  limit?: number;
}

function hasEnd(vevent: ICAL.Component): boolean {
  return vevent.hasProperty('dtend') || vevent.hasProperty('duration');
}

function cancelled(vevent: ICAL.Component): boolean {
  return String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function build(
  record: EventRecord,
  vevent: ICAL.Component,
  start: ICAL.Time,
  end: ICAL.Time | null,
  key: string | null,
  options: ExpandOptions,
  recurrenceId: ICAL.Time | null = null,
): Occurrence {
  const zone = options.floatingZone ?? null;
  const d = nostrD(record.uid, key ?? undefined);
  const allDay = start.isDate;
  return {
    record,
    event: vevent,
    d,
    id: publicEventId(options.calendarD, d),
    occurrence: key,
    allDay,
    start: unix(start, zone),
    end: end ? unix(end, zone) : null,
    startDate: allDay ? dateString(start) : null,
    endDate: allDay && end ? dateString(end) : null,
    startTzid: tzidOf(start, zone),
    endTzid: end ? tzidOf(end, zone) : null,
    floating: isFloating(start),
    cancelled: cancelled(vevent),
    startTime: start,
    endTime: end,
    recurrenceId,
  };
}

// Overlap of [start, end) with the window; an event with no end lasts a day
// when it is all-day and an instant otherwise.
function inWindow(o: Occurrence, window: Window): boolean {
  const end = o.end ?? (o.allDay ? o.start + 86400 : o.start);
  return o.start <= window.to && (end > window.from || (end === o.start && o.start >= window.from));
}

export interface Expansion {
  items: Occurrence[];
  truncated: boolean;
  // Set when the record could not be expanded; it then yields no occurrences.
  error?: string;
}

export function occurrences(record: EventRecord, window: Window, options: ExpandOptions): Expansion {
  try {
    return expand(record, window, options);
  } catch (error) {
    return { items: [], truncated: false, error: (error as Error).message };
  }
}

// One instance of the recurrence set: its original start, and its end when
// an RDATE period gives one.
interface Instance {
  recurrenceId: ICAL.Time;
  periodEnd: ICAL.Time | null;
}

function timesOf(property: ICAL.Property): Array<ICAL.Time | ICAL.Period> {
  return property.getValues() as Array<ICAL.Time | ICAL.Period>;
}

function periodEnd(period: ICAL.Period): ICAL.Time | null {
  if (period.end) return period.end;
  if (period.duration) {
    const end = period.start.clone();
    end.addDuration(period.duration);
    return end;
  }
  return null;
}

// The recurrence set of a master (RFC 5545 § 3.8.5): DTSTART, every RRULE
// instance and RDATE, minus EXDATE, up to the window's end. Occurrences are
// matched by the index's occurrence key (the instant, or the date), so values
// written in different zones, or repeated, compare correctly.
function recurrenceSet(master: ICAL.Component, window: Window, zone: string | null, guard: { truncated: boolean }): Instance[] {
  const dtstart = new ICAL.Event(master).startDate;
  const key = (t: ICAL.Time) => occurrenceKey(t, zone);
  const excludedKeys = new Set<string>();
  const excludedDates = new Set<string>();
  for (const property of master.getAllProperties('exdate')) {
    for (const value of timesOf(property)) {
      if (!(value instanceof ICAL.Time)) continue;
      excludedKeys.add(key(value));
      if (value.isDate) excludedDates.add(dateString(value));
    }
  }
  const isExcluded = (t: ICAL.Time) => excludedKeys.has(key(t)) || (!t.isDate && excludedDates.has(dateString(t)));

  const found = new Map<string, Instance>();
  const add = (t: ICAL.Time, end: ICAL.Time | null = null): void => {
    const k = key(t);
    if (!found.has(k) && !isExcluded(t)) found.set(k, { recurrenceId: t, periodEnd: end });
  };

  // DTSTART is always the first instance, and counts toward COUNT.
  add(dtstart);
  for (const property of master.getAllProperties('rrule')) {
    const recur = property.getFirstValue() as ICAL.Recur;
    const iterator = recur.iterator(dtstart);
    let allowance = recur.count ?? Infinity;
    let synced = false;
    for (let i = 0, next = iterator.next(); next; i += 1, next = iterator.next()) {
      if (i >= MAX_ITERATIONS) {
        guard.truncated = true;
        break;
      }
      if (i === 0) {
        synced = key(next) === key(dtstart);
        if (!synced) allowance -= 1;
      }
      if (allowance <= 0) break;
      allowance -= 1;
      if (unix(next, zone) > window.to) break;
      // The iterator returns one Time object and moves it on each call.
      add(next.clone());
    }
  }
  for (const property of master.getAllProperties('rdate')) {
    for (const value of timesOf(property)) {
      if (value instanceof ICAL.Period) add(value.start, periodEnd(value));
      else add(value);
    }
  }
  return [...found.values()].sort((a, b) => unix(a.recurrenceId, zone) - unix(b.recurrenceId, zone));
}

function expand(record: EventRecord, window: Window, options: ExpandOptions): Expansion {
  const limit = options.limit ?? MAX_OCCURRENCES;
  const zone = options.floatingZone ?? null;
  const key = (t: ICAL.Time) => occurrenceKey(t, zone);
  const items: Occurrence[] = [];
  const guard = { truncated: false };
  const push = (o: Occurrence): boolean => {
    if (!inWindow(o, window)) return true;
    if (items.length >= limit) {
      guard.truncated = true;
      return false;
    }
    items.push(o);
    return true;
  };

  const direct = new Map<string, ICAL.Component>();
  const ranged: Array<{ from: string; fromUnix: number; override: ICAL.Component }> = [];
  for (const override of record.overrides) {
    const property = override.getFirstProperty('recurrence-id');
    const recurrenceId = property?.getFirstValue();
    if (!(recurrenceId instanceof ICAL.Time)) continue;
    if (String(property!.getParameter('range') ?? '').toUpperCase() === 'THISANDFUTURE') {
      ranged.push({ from: key(recurrenceId), fromUnix: unix(recurrenceId, zone), override });
    } else {
      direct.set(key(recurrenceId), override);
    }
  }
  ranged.sort((a, b) => a.fromUnix - b.fromUnix);
  const used = new Set<ICAL.Component>();

  const fromOverride = (override: ICAL.Component, occurrence: string | null, recurrenceId: ICAL.Time | null): boolean => {
    used.add(override);
    const event = new ICAL.Event(override);
    return push(build(record, override, event.startDate, hasEnd(override) ? event.endDate : null, occurrence, options, recurrenceId));
  };

  const master = record.master;
  if (master && !(master.hasProperty('rrule') || master.hasProperty('rdate'))) {
    const event = new ICAL.Event(master);
    const own = direct.get(key(event.startDate));
    if (own) fromOverride(own, null, null);
    else push(build(record, master, event.startDate, hasEnd(master) ? event.endDate : null, null, options));
  } else if (master) {
    const event = new ICAL.Event(master);
    const duration = hasEnd(master) ? event.duration : null;
    for (const instance of recurrenceSet(master, window, zone, guard)) {
      const k = key(instance.recurrenceId);
      const override = direct.get(k);
      if (override) {
        if (!fromOverride(override, k, instance.recurrenceId)) break;
        continue;
      }
      const range = ranged.filter((r) => r.fromUnix <= unix(instance.recurrenceId, zone)).at(-1);
      let item = master;
      let start = instance.recurrenceId.clone();
      let end: ICAL.Time | null = null;
      if (range) {
        item = range.override;
        used.add(item);
        const shifted = new ICAL.Event(item);
        const original = item.getFirstPropertyValue('recurrence-id') as ICAL.Time;
        start = start.clone();
        start.addDuration(shifted.startDate.subtractDateTz(original));
        if (hasEnd(item)) {
          end = start.clone();
          end.addDuration(shifted.duration);
        }
      } else if (instance.periodEnd) {
        end = instance.periodEnd;
      } else if (duration) {
        end = start.clone();
        end.addDuration(duration);
      }
      if (!push(build(record, item, start, end, k, options, instance.recurrenceId))) break;
    }
  }

  // Overrides no instance reached: their master is absent, or it does not
  // produce their RECURRENCE-ID. Each is an occurrence of its own.
  for (const override of record.overrides) {
    if (used.has(override) || guard.truncated) continue;
    const recurrenceId = override.getFirstPropertyValue('recurrence-id');
    if (!(recurrenceId instanceof ICAL.Time)) continue;
    fromOverride(override, key(recurrenceId), recurrenceId);
  }

  // One occurrence per address: the first wins.
  const seen = new Set<string>();
  const unique = items.sort((a, b) => a.start - b.start).filter((o) => (seen.has(o.d) ? false : (seen.add(o.d), true)));
  return { items: unique, truncated: guard.truncated };
}
