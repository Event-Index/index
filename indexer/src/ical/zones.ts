// IANA time zones for ical.js.
//
// Feeds often name a TZID without carrying its VTIMEZONE block. ical.js falls
// back to its TimezoneService for such a TZID, so every TZID a feed uses but
// does not define is registered there under the exact name the feed wrote,
// built from tzdb data (timezones-ical-library).

import ICAL from 'ical.js';
import { tzlib_get_ical_block } from 'timezones-ical-library';

const canonicalCache = new Map<string, string | null>();

function isIntlZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function tzdbBlock(name: string): [block: string, tzid: string] | null {
  if (!isIntlZone(name)) return null;
  const result = tzlib_get_ical_block(name);
  if (!Array.isArray(result) || !result[0] || !result[1]) return null;
  return [result[0], result[1].replace(/^TZID=/, '')];
}

// The IANA name a TZID stands for, or null. Accepts aliases ("US/Pacific")
// and vendor prefixes ("/mozilla.org/20050126_1/America/New_York").
export function canonicalZone(tzid: string): string | null {
  const cached = canonicalCache.get(tzid);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  const parts = tzid.replace(/^"|"$/g, '').split('/').filter(Boolean);
  for (let take = Math.min(parts.length, 3); take >= 1 && !found; take -= 1) {
    const candidate = parts.slice(-take).join('/');
    found = tzdbBlock(candidate)?.[1] ?? null;
  }
  canonicalCache.set(tzid, found);
  return found;
}

// A VTIMEZONE component from tzdb, with its TZID set to the name given.
export function vtimezoneFor(tzid: string): ICAL.Component | null {
  const canonical = canonicalZone(tzid);
  if (!canonical) return null;
  const block = tzdbBlock(canonical)?.[0];
  if (!block) return null;
  const component = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR\r\n`)).getFirstSubcomponent('vtimezone');
  if (!component) return null;
  component.updatePropertyWithValue('tzid', tzid);
  return component;
}

export function bundledTimezone(tzid: string): ICAL.Timezone | null {
  const component = vtimezoneFor(tzid);
  return component ? new ICAL.Timezone(component) : null;
}

export interface ZoneReport {
  // Every TZID the calendar uses, mapped to its IANA name (feed-defined
  // zones included when their TZID is an IANA name).
  resolved: Map<string, string>;
  // TZIDs defined by a VTIMEZONE in the feed itself.
  fromFeed: string[];
  // TZIDs neither defined in the feed nor known to tzdb; their times are
  // read as floating.
  unknown: string[];
}

export function referencedTzids(calendar: ICAL.Component): string[] {
  const found = new Set<string>();
  const walk = (component: ICAL.Component): void => {
    if (component.name === 'vtimezone') return;
    for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid === 'string' && tzid) found.add(tzid);
    }
    for (const child of component.getAllSubcomponents()) walk(child);
  };
  walk(calendar);
  return [...found].sort();
}

export function registerZones(calendar: ICAL.Component): ZoneReport {
  const defined = new Set(
    calendar.getAllSubcomponents('vtimezone').map((z) => String(z.getFirstPropertyValue('tzid'))),
  );
  const report: ZoneReport = { resolved: new Map(), fromFeed: [], unknown: [] };
  for (const tzid of referencedTzids(calendar)) {
    const canonical = canonicalZone(tzid);
    if (defined.has(tzid)) {
      report.fromFeed.push(tzid);
      if (canonical) report.resolved.set(tzid, canonical);
      continue;
    }
    if (!canonical) {
      report.unknown.push(tzid);
      continue;
    }
    report.resolved.set(tzid, canonical);
    if (!ICAL.TimezoneService.has(tzid)) {
      const zone = bundledTimezone(tzid);
      if (zone) ICAL.TimezoneService.register(zone, tzid);
    }
  }
  return report;
}
