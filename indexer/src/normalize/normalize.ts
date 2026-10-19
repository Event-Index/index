// Feed text to normalized records: one VCALENDAR per UID holding the master
// VEVENT and its overrides, the calendar's own properties, and the VTIMEZONE
// blocks its events use. The profile is spec/icalendar-profile.md.

import ICAL from 'ical.js';
import '../ical/design.ts';
import { adapterFor, type Adapter, type CalendarSide } from '../adapters/index.ts';
import { registerZones, vtimezoneFor, canonicalZone, type ZoneReport } from '../ical/zones.ts';
import { htmlToText, looksLikeHtml, markdownToText } from '../ical/text.ts';
import { nostrD, publicEventId } from '../project/ids.ts';
import { isFloating, occurrenceKey } from '../project/time.ts';
import { geoOf } from '../project/nip52.ts';
import { zoneAt } from '../project/venue-zone.ts';
import type { Role, Source } from '../types.ts';

export const PRODID = '-//Event Index//index//EN';

export interface FeedContext {
  d: string;
  source: Source;
  role: Role;
  feedUrl: string;
  pageUrl: string | null;
  // The name on the directory entry, used when the feed names nothing.
  entryName?: string | null;
  // The directory entry's address, `39999:<index key>:<d>`.
  calendarAddress?: string | null;
}

export type NameSource = 'NAME' | 'X-WR-CALNAME' | 'ORGANIZER' | 'entry';

export interface CalendarMeta {
  name: string | null;
  nameSource: NameSource | null;
  // The feed's own name is a platform's default ("Personal" on Luma).
  platformDefault: boolean;
  description: string | null;
  url: string | null;
  image: string | null;
  color: string | null;
  refreshInterval: number | null;
  timezone: string | null;
}

export interface EventRecord {
  uid: string;
  // The public id of the event (of the series, for a recurring event).
  id: string;
  component: ICAL.Component;
  master: ICAL.Component | null;
  overrides: ICAL.Component[];
}

export interface LogEntry {
  code: 'no-uid' | 'no-start' | 'no-title' | 'bad-value' | 'duplicate-uid' | 'unknown-tzid' | 'multiple-calendars' | 'unparseable-event' | 'unparseable-line';
  uid?: string;
  detail?: string;
}

export interface NormalizedFeed {
  context: FeedContext;
  calendar: CalendarMeta;
  records: EventRecord[];
  zones: ZoneReport;
  log: LogEntry[];
}

export class FeedParseError extends Error {}

const EVENT_PROPERTIES = new Set([
  'uid', 'summary', 'dtstart', 'dtend', 'duration', 'description', 'styled-description', 'location', 'geo',
  'url', 'image', 'attach', 'categories', 'status', 'sequence', 'last-modified', 'created', 'rrule', 'rdate',
  'exdate', 'recurrence-id', 'organizer', 'conference', 'structured-data',
]);
const EVENT_SUBCOMPONENTS = new Set(['vlocation', 'participant']);
const CALENDAR_PROPERTIES = new Set([
  'name', 'description', 'url', 'image', 'color', 'refresh-interval', 'source', 'last-modified',
]);
const CALENDAR_X_PROPERTIES = /^x-(wr-|published-ttl$)/;
const EMPTY_DROPPED = new Set(['summary', 'description', 'location', 'url']);
const MARKDOWN = /\*\*|__|\[[^\]\n]*\]\([^)\s]+\)|\\[-~*_`#>!.,]|^#{1,6} /m;

type JCal = [string, unknown[], unknown[]];
type JProp = [string, Record<string, unknown>, string, ...unknown[]];

function textValue(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function clone(component: ICAL.Component): ICAL.Component {
  return new ICAL.Component(structuredClone(component.toJSON()) as JCal);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function isAddress(value: unknown): boolean {
  return typeof value === 'string' && (/^mailto:/i.test(value.trim()) || /@/.test(value));
}

// Whether any of a property's values is or holds an e-mail address.
function holdsAddress(p: JProp): boolean {
  return p.slice(3).some((v) => typeof v === 'string' && (/^mailto:/i.test(v.trim()) || EMAIL.test(v)));
}

export function holdsEmail(text: string | null): boolean {
  return !!text && EMAIL.test(text);
}

const PROSE = new Set(['description', 'styled-description', 'summary', 'comment', 'name']);

// A subcomponent keeps no index property and no address outside its prose.
function scrubSubcomponent(c: JCal): JCal {
  const properties = (c[1] as JProp[]).filter((p) => !p[0].startsWith('x-eventindex-') && (PROSE.has(p[0]) || !holdsAddress(p)));
  return [c[0], properties, (c[2] as JCal[]).map(scrubSubcomponent)];
}

// A component rebuilt from its jCal with only the properties `keep` accepts.
// (Removing properties from a live component while iterating skips some.)
function filtered(component: ICAL.Component, keep: (p: JProp) => boolean): ICAL.Component {
  const jcal = structuredClone(component.toJSON()) as JCal;
  return new ICAL.Component([jcal[0], (jcal[1] as JProp[]).filter(keep), jcal[2]]);
}

const PARTICIPANT_ADDRESSES = new Set(['calendar-address', 'email']);

// Keeps the profile's properties and subcomponents, in feed order. The
// record keeps an e-mail address only on ORGANIZER.
function applyProfile(vevent: ICAL.Component): ICAL.Component {
  const jcal = structuredClone(vevent.toJSON()) as JCal;
  const properties = (jcal[1] as JProp[]).filter((p) => {
    const name = p[0];
    if (!(EVENT_PROPERTIES.has(name) || name.startsWith('x-'))) return false;
    if (EMPTY_DROPPED.has(name) && (p.length < 4 || String(p[3] ?? '').trim() === '')) return false;
    if ((name.startsWith('x-') || name === 'url') && holdsAddress(p)) return false;
    return true;
  });
  const subcomponents = (jcal[2] as JCal[])
    .filter((c) => EVENT_SUBCOMPONENTS.has(c[0]))
    .map((c): JCal => (c[0] === 'participant'
      ? [c[0], (c[1] as JProp[]).filter((p) => !(PARTICIPANT_ADDRESSES.has(p[0]) && isAddress(p[3]))), c[2]]
      : c))
    .map(scrubSubcomponent);
  return new ICAL.Component(['vevent', properties, subcomponents]);
}

// The zone at the venue of an event whose times are in UTC, from its GEO.
function zoneOfVenue(vevent: ICAL.Component): string | null {
  const start = vevent.getFirstPropertyValue('dtstart');
  if (!(start instanceof ICAL.Time) || start.isDate || isFloating(start) || start.zone?.tzid !== 'UTC') return null;
  const geo = geoOf(vevent);
  return geo ? zoneAt(geo[0], geo[1]) : null;
}

// Markup in DESCRIPTION moves to STYLED-DESCRIPTION (RFC 9073), and
// DESCRIPTION becomes its plain text, marked DERIVED.
function splitDescription(vevent: ICAL.Component, adapter: Adapter): void {
  const property = vevent.getFirstProperty('description');
  if (!property || vevent.hasProperty('styled-description')) return;
  const value = String(property.getFirstValue() ?? '');
  let format: string | null = null;
  let plain = value;
  if (looksLikeHtml(value) || vevent.getFirstPropertyValue('x-moz-google-html-description') === 'true') {
    format = 'text/html';
    plain = htmlToText(value);
  } else if (adapter.descriptionFormat === 'markdown' && MARKDOWN.test(value)) {
    format = 'text/markdown';
    plain = markdownToText(value);
  }
  if (!format) return;
  const styled = new ICAL.Property('styled-description');
  styled.setParameter('fmttype', format);
  styled.setValue(value);
  vevent.addProperty(styled);
  if (plain) {
    property.setValue(plain);
    property.setParameter('derived', 'TRUE');
  } else {
    vevent.removeProperty(property);
  }
}

function organizerName(vevent: ICAL.Component): string | null {
  const property = vevent.getFirstProperty('organizer');
  if (!property) return null;
  const cn = property.getParameter('cn');
  if (typeof cn === 'string' && cn.trim()) return cn.trim();
  const value = String(property.getFirstValue() ?? '').trim();
  if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return null;
}

function referencedTzids(vevent: ICAL.Component): string[] {
  const found = new Set<string>();
  const walk = (component: ICAL.Component): void => {
    for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid === 'string' && tzid) found.add(tzid);
    }
    for (const sub of component.getAllSubcomponents()) walk(sub);
  };
  walk(vevent);
  return [...found];
}

function sequenceOf(vevent: ICAL.Component): number {
  const value = Number(vevent.getFirstPropertyValue('sequence'));
  return Number.isFinite(value) ? value : 0;
}

function modifiedOf(vevent: ICAL.Component): string {
  const property = vevent.getFirstProperty('last-modified');
  return property ? String((property.toJSON() as JProp)[3] ?? '') : '';
}

// The later of two copies of one event: higher SEQUENCE, then later
// LAST-MODIFIED, then the one further down the feed.
function newer(a: Candidate, b: Candidate): Candidate {
  const bySequence = sequenceOf(b.vevent) - sequenceOf(a.vevent);
  if (bySequence !== 0) return bySequence > 0 ? b : a;
  const ma = modifiedOf(a.vevent);
  const mb = modifiedOf(b.vevent);
  if (ma !== mb) return mb > ma ? b : a;
  return b.index > a.index ? b : a;
}

interface Candidate {
  uid: string;
  recurrenceKey: string | null;
  vevent: ICAL.Component;
  index: number;
}

function recurrenceKeyOf(vevent: ICAL.Component): string | null {
  const property = vevent.getFirstProperty('recurrence-id');
  if (!property) return null;
  const jprop = property.toJSON() as JProp;
  return `${String(jprop[1]?.['tzid'] ?? '')}|${String(jprop[3] ?? '')}`;
}

// The components of a VCALENDAR as text: the calendar's own content lines,
// and each top-level component (VEVENT, VTIMEZONE, …) with its lines.
function splitCalendar(text: string): { own: string[]; components: Array<{ name: string; lines: string[] }> } {
  const own: string[] = [];
  const components: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  let depth = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const continuation = line.startsWith(' ') || line.startsWith('\t');
    const begin = !continuation && /^BEGIN:/i.test(line);
    const end = !continuation && /^END:/i.test(line);
    if (begin) depth += 1;
    if (depth === 1 && !begin && !end) own.push(line);
    else if (depth === 2 && begin) current = { name: line.slice(6).trim().toLowerCase(), lines: [line] };
    else if (current) current.lines.push(line);
    if (end) {
      if (depth === 2 && current) {
        components.push(current);
        current = null;
      }
      depth -= 1;
    }
  }
  return { own, components };
}

function parseStrict(text: string): ICAL.Component {
  let jcal = ICAL.parse(text) as unknown;
  if (Array.isArray(jcal) && Array.isArray(jcal[0])) jcal = jcal[0];
  return new ICAL.Component(jcal as JCal);
}

// When the feed as a whole does not parse, each part is parsed alone and the
// parts that fail are left out and logged.
function parseTolerant(text: string, log: LogEntry[]): ICAL.Component {
  const { own, components } = splitCalendar(text);
  const calendar = new ICAL.Component('vcalendar');
  const lines: string[] = [];
  for (const line of own) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) lines[lines.length - 1] += `\r\n${line}`;
    else lines.push(line);
  }
  for (const line of lines) {
    try {
      const one = parseStrict(`BEGIN:VCALENDAR\r\n${line}\r\nEND:VCALENDAR\r\n`);
      for (const property of one.getAllProperties()) calendar.addProperty(new ICAL.Property(structuredClone(property.toJSON())));
    } catch {
      log.push({ code: 'unparseable-line', detail: line.slice(0, 60) });
    }
  }
  for (const component of components) {
    try {
      const sub = parseStrict(`BEGIN:VCALENDAR\r\n${component.lines.join('\r\n')}\r\nEND:VCALENDAR\r\n`).getFirstSubcomponent();
      if (sub) calendar.addSubcomponent(sub);
    } catch (error) {
      const uid = /^UID:(.*)$/im.exec(component.lines.join('\n').replace(/\n[ \t]/g, ''))?.[1]?.trim();
      log.push({ code: 'unparseable-event', uid, detail: `${component.name}: ${(error as Error).message}` });
    }
  }
  return calendar;
}

export function parseCalendar(text: string, log: LogEntry[] = []): ICAL.Component {
  const clean = text.replace(/^\uFEFF/, '');
  let component: ICAL.Component;
  try {
    let jcal = ICAL.parse(clean) as unknown;
    if (Array.isArray(jcal) && Array.isArray(jcal[0])) {
      log.push({ code: 'multiple-calendars', detail: String(jcal.length) });
      jcal = jcal[0];
    }
    component = new ICAL.Component(jcal as JCal);
  } catch (error) {
    if (!/^\s*BEGIN:VCALENDAR/i.test(clean)) throw new FeedParseError(`not iCalendar: ${(error as Error).message}`);
    component = parseTolerant(clean, log);
  }
  if (component.name !== 'vcalendar') throw new FeedParseError(`not a VCALENDAR: ${component.name}`);
  return component;
}

const TIME_VALUED = new Set(['dtstart', 'dtend', 'duration', 'recurrence-id', 'exdate', 'rdate', 'rrule', 'geo', 'last-modified', 'created']);

// Names of the time-valued properties whose values cannot be read.
function unreadable(vevent: ICAL.Component): Set<string> {
  const bad = new Set<string>();
  for (const property of vevent.getAllProperties()) {
    if (!TIME_VALUED.has(property.name)) continue;
    try {
      property.getValues();
    } catch {
      bad.add(property.name);
    }
  }
  return bad;
}

function calendarMeta(calendar: ICAL.Component, adapter: Adapter, ctx: FeedContext, organizers: Map<string, number>): CalendarMeta {
  const ownName = textValue(calendar, 'name');
  const wrName = textValue(calendar, 'x-wr-calname');
  const isDefault = (n: string | null) => !!n && !!adapter.isDefaultCalendarName?.(n);
  // An e-mail address is never a name (Google names a primary calendar
  // after its owner's address).
  const usable = (n: string | null) => !!n && !isDefault(n) && !holdsEmail(n);
  let name: string | null = null;
  let nameSource: NameSource | null = null;
  if (usable(ownName)) {
    name = ownName;
    nameSource = 'NAME';
  } else if (usable(wrName)) {
    name = wrName;
    nameSource = 'X-WR-CALNAME';
  } else {
    const ranked = [...organizers.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (ranked[0]) {
      name = ranked[0][0];
      nameSource = 'ORGANIZER';
    } else if (ctx.entryName) {
      name = ctx.entryName;
      nameSource = 'entry';
    }
  }

  const descriptions = [textValue(calendar, 'description'), textValue(calendar, 'x-wr-caldesc')];
  const description = descriptions.find((d) => d && !adapter.isDefaultCalendarDescription?.(d)) ?? null;

  let refreshInterval: number | null = null;
  for (const property of ['refresh-interval', 'x-published-ttl']) {
    const value = calendar.getFirstPropertyValue(property);
    if (value === null || value === undefined) continue;
    try {
      const duration = value instanceof ICAL.Duration ? value : ICAL.Duration.fromString(String(value));
      refreshInterval = duration.toSeconds();
      break;
    } catch {
      // an unreadable interval is ignored
    }
  }

  const zone = textValue(calendar, 'x-wr-timezone');
  return {
    name,
    nameSource,
    platformDefault: isDefault(ownName) || (!ownName && isDefault(wrName)),
    description,
    url: textValue(calendar, 'url') ?? ctx.pageUrl,
    image: textValue(calendar, 'image'),
    color: textValue(calendar, 'color'),
    refreshInterval,
    timezone: zone ? canonicalZone(zone) : null,
  };
}

// A stored record back as an EventRecord (its text is the record's own
// VCALENDAR, VTIMEZONE blocks included).
export function recordFromText(text: string, uid: string, id: string): EventRecord {
  const component = parseCalendar(text);
  registerZones(component);
  const vevents = component.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? null;
  return { uid, id, component, master, overrides: vevents.filter((v) => v.hasProperty('recurrence-id')) };
}

export function normalizeFeed(text: string, ctx: FeedContext): NormalizedFeed {
  const log: LogEntry[] = [];
  const calendar = parseCalendar(text, log);
  const zones = registerZones(calendar);
  for (const tzid of zones.unknown) log.push({ code: 'unknown-tzid', detail: tzid });
  const adapter = adapterFor(ctx.source);
  const side: CalendarSide = { name: textValue(calendar, 'name') ?? textValue(calendar, 'x-wr-calname') };

  const masters = new Map<string, Candidate>();
  const overrides = new Map<string, Map<string, Candidate>>();
  const organizers = new Map<string, number>();
  const order: string[] = [];

  calendar.getAllSubcomponents('vevent').forEach((source, index) => {
    const uid = textValue(source, 'uid');
    if (!uid) {
      log.push({ code: 'no-uid', detail: textValue(source, 'summary') ?? undefined });
      return;
    }
    if (!source.hasProperty('dtstart')) {
      log.push({ code: 'no-start', uid });
      return;
    }
    const bad = unreadable(source);
    for (const name of [...bad].sort()) log.push({ code: 'bad-value', uid, detail: name });
    if (bad.has('dtstart')) return;
    // A feed cannot speak for the index.
    const working = filtered(clone(source), (p) => !p[0].startsWith('x-eventindex-') && !bad.has(p[0]));
    // Read before an adapter hides the venue; its coordinates go no further.
    const venueZone = zoneOfVenue(working);
    adapter.event?.(working, side);
    splitDescription(working, adapter);
    const vevent = applyProfile(working);
    if (venueZone) vevent.addPropertyWithValue('x-eventindex-tzid', venueZone);

    const organizer = organizerName(vevent);
    if (organizer && !adapter.isDefaultOrganizerName?.(organizer) && !holdsEmail(organizer)) {
      organizers.set(organizer, (organizers.get(organizer) ?? 0) + 1);
    }

    const candidate: Candidate = { uid, recurrenceKey: recurrenceKeyOf(vevent), vevent, index };
    if (!masters.has(uid) && !overrides.has(uid)) order.push(uid);
    if (candidate.recurrenceKey === null) {
      const existing = masters.get(uid);
      if (existing) log.push({ code: 'duplicate-uid', uid });
      masters.set(uid, existing ? newer(existing, candidate) : candidate);
    } else {
      const byKey = overrides.get(uid) ?? new Map<string, Candidate>();
      const existing = byKey.get(candidate.recurrenceKey);
      if (existing) log.push({ code: 'duplicate-uid', uid, detail: candidate.recurrenceKey });
      byKey.set(candidate.recurrenceKey, existing ? newer(existing, candidate) : candidate);
      overrides.set(uid, byKey);
    }
  });

  const feedZones = new Map(
    calendar.getAllSubcomponents('vtimezone').map((z) => [String(z.getFirstPropertyValue('tzid')), z] as const),
  );
  const calendarProperties = calendar
    .getAllProperties()
    .filter((p) => CALENDAR_PROPERTIES.has(p.name) || CALENDAR_X_PROPERTIES.test(p.name));

  const meta = calendarMeta(calendar, adapter, ctx, organizers);
  const records = order.map((uid): EventRecord => {
    const master = masters.get(uid)?.vevent ?? null;
    const own = [...(overrides.get(uid)?.values() ?? [])].sort((a, b) => (a.recurrenceKey! < b.recurrenceKey! ? -1 : 1));
    const events = [...(master ? [master] : []), ...own.map((c) => c.vevent)];

    const component = new ICAL.Component('vcalendar');
    component.addPropertyWithValue('version', '2.0');
    component.addPropertyWithValue('prodid', PRODID);
    for (const property of calendarProperties) component.addProperty(new ICAL.Property(structuredClone(property.toJSON())));
    const tzids = [...new Set(events.flatMap(referencedTzids))].sort();
    for (const tzid of tzids) {
      const zone = feedZones.has(tzid) ? clone(feedZones.get(tzid)!) : vtimezoneFor(tzid);
      if (zone) component.addSubcomponent(zone);
    }
    for (const vevent of events) component.addSubcomponent(vevent);

    const id = publicEventId(ctx.d, nostrD(uid));
    for (const vevent of events) {
      const recurrenceId = vevent.getFirstPropertyValue('recurrence-id');
      const eventId = recurrenceId instanceof ICAL.Time ? publicEventId(ctx.d, nostrD(uid, occurrenceKey(recurrenceId, meta.timezone))) : id;
      if (ctx.calendarAddress) vevent.addPropertyWithValue('x-eventindex-calendar', ctx.calendarAddress);
      vevent.addPropertyWithValue('x-eventindex-source', ctx.source);
      vevent.addPropertyWithValue('x-eventindex-id', eventId);
    }
    return { uid, id, component, master, overrides: own.map((c) => c.vevent) };
  });

  return { context: ctx, calendar: meta, records, zones, log };
}
