// The record's public projections: iCalendar (.ics), jCal and schema.org
// JSON-LD. ORGANIZER and ATTENDEE never appear; a source whose terms reserve
// event content gets the summary in place of the description and no images;
// a hidden venue's coordinates are coarsened.

import ICAL from 'ical.js';
import '../ical/design.ts';
import type { Adapter } from '../adapters/index.ts';
import { adapterFor } from '../adapters/index.ts';
import type { EventRecord, NormalizedFeed } from '../normalize/normalize.ts';
import { API_BASE, geoOf, imageOf, locationsOf, summaryOf, venueHidden } from './nip52.ts';
import type { Occurrence } from './window.ts';

export interface PublicContext {
  calendarName: string;
  calendarUrl: string | null;
  adapter: Adapter;
  apiBase: string;
  // When the record last changed; every VEVENT's DTSTAMP.
  changedAt: number;
}

export function publicContext(feed: NormalizedFeed, changedAt: number): PublicContext {
  return {
    calendarName: feed.calendar.name ?? feed.context.d,
    calendarUrl: feed.calendar.url,
    adapter: adapterFor(feed.context.source),
    apiBase: API_BASE,
    changedAt,
  };
}

type JCal = [string, unknown[], unknown[]];

function clone(component: ICAL.Component): ICAL.Component {
  return new ICAL.Component(structuredClone(component.toJSON()) as JCal);
}

type JProp = [string, Record<string, unknown>, string, ...unknown[]];

const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

function isImage(p: JProp): boolean {
  if (p[0] === 'image') return true;
  if (p[0] !== 'attach') return false;
  const type = String(p[1]?.['fmttype'] ?? '').toLowerCase();
  return type.startsWith('image/') || (!type && IMAGE_URL.test(String(p[3] ?? '')));
}

function isRichDescription(p: JProp): boolean {
  return ['styled-description', 'structured-data', 'x-alt-desc'].includes(p[0])
    || String(p[1]?.['fmttype'] ?? '').toLowerCase() === 'text/html';
}

function scrubSub(c: JCal): JCal {
  return [c[0], (c[1] as JProp[]).filter((p) => !p[0].startsWith('x-eventindex-')), (c[2] as JCal[]).map(scrubSub)];
}

function scrub(vevent: ICAL.Component, ctx: PublicContext): ICAL.Component {
  const jcal = structuredClone(vevent.toJSON()) as JCal;
  const policy = ctx.adapter.policy;
  const hidden = venueHidden(vevent);
  const properties = (jcal[1] as JProp[]).filter((p) => {
    const name = p[0];
    if (name === 'organizer' || name === 'attendee' || name === 'dtstamp') return false;
    if (hidden && (name === 'geo' || name === 'location')) return false;
    if (!policy.fullDescription && isRichDescription(p)) return false;
    if (!policy.images && isImage(p)) return false;
    return true;
  });
  const subcomponents = (jcal[2] as JCal[]).filter((c) => !(hidden && c[0] === 'vlocation')).map(scrubSub);
  const out = new ICAL.Component([jcal[0], properties, subcomponents]);
  out.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(ctx.changedAt * 1000), true));
  if (!policy.fullDescription) {
    const summary = summaryOf(vevent, ctx.adapter);
    out.removeAllProperties('description');
    if (summary) out.addPropertyWithValue('description', summary);
  }
  return out;
}

function instance(o: Occurrence): ICAL.Component {
  const vevent = clone(o.event);
  for (const name of ['rrule', 'rdate', 'exdate', 'recurrence-id', 'dtstart', 'dtend', 'duration']) vevent.removeAllProperties(name);
  const event = new ICAL.Event(vevent);
  event.startDate = o.startTime;
  if (o.endTime) event.endDate = o.endTime;
  if (o.recurrenceId) {
    const property = new ICAL.Property('recurrence-id');
    const zone = o.recurrenceId.zone;
    if (zone && zone !== ICAL.Timezone.utcTimezone && zone !== ICAL.Timezone.localTimezone) property.setParameter('tzid', zone.tzid);
    property.setValue(o.recurrenceId);
    vevent.addProperty(property);
  }
  return vevent;
}

function zonesUsed(events: ICAL.Component[]): Set<string> {
  const used = new Set<string>();
  for (const event of events) {
    for (const property of event.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid === 'string') used.add(tzid);
    }
  }
  return used;
}

// The record (or one occurrence of it) as a public VCALENDAR.
export function publicCalendar(record: EventRecord, occurrence: Occurrence | null, ctx: PublicContext): ICAL.Component {
  const source = record.component;
  const single = occurrence && occurrence.occurrence !== null ? [instance(occurrence)] : source.getAllSubcomponents('vevent').map(clone);
  const events = single.map((e) => scrub(e, ctx));
  const used = zonesUsed(events);
  const jcal = structuredClone(source.toJSON()) as JCal;
  const calendar = new ICAL.Component([jcal[0], jcal[1], []]);
  for (const zone of source.getAllSubcomponents('vtimezone')) {
    if (used.has(String(zone.getFirstPropertyValue('tzid')))) calendar.addSubcomponent(clone(zone));
  }
  for (const event of events) calendar.addSubcomponent(event);
  return calendar;
}

export function toIcs(calendar: ICAL.Component): string {
  return `${ICAL.stringify(calendar.toJSON())}\r\n`;
}

export function toJcal(calendar: ICAL.Component): unknown {
  return structuredClone(calendar.toJSON());
}

function offset(unix: number, tzid: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'longOffset' }).formatToParts(new Date(unix * 1000));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-]\d{2}:\d{2})?/.exec(name);
  return match?.[1] ?? '+00:00';
}

function isoInstant(unix: number, tzid: string | null): string {
  if (!tzid) return new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset(unix, tzid)}`;
}

function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

export function toJsonLd(o: Occurrence, ctx: PublicContext): Record<string, unknown> {
  const vevent = o.event;
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    '@id': `${ctx.apiBase}/events/byid/${o.id}`,
    name: String(vevent.getFirstPropertyValue('summary') ?? '').trim(),
  };
  if (o.allDay) {
    ld['startDate'] = o.startDate;
    if (o.endDate && o.endDate > o.startDate!) ld['endDate'] = previousDay(o.endDate);
  } else {
    ld['startDate'] = isoInstant(o.start, o.startTzid);
    if (o.end !== null && o.end > o.start) ld['endDate'] = isoInstant(o.end, o.endTzid ?? o.startTzid);
  }
  ld['eventStatus'] = o.cancelled ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled';

  // A hidden venue has no place.
  const hidden = venueHidden(vevent);
  const where = hidden ? undefined : locationsOf(vevent)[0];
  const geo = hidden ? null : geoOf(vevent);
  if (where && /^https?:\/\//i.test(where)) {
    ld['location'] = { '@type': 'VirtualLocation', url: where };
    ld['eventAttendanceMode'] = 'https://schema.org/OnlineEventAttendanceMode';
  } else if (where || geo) {
    const place: Record<string, unknown> = { '@type': 'Place' };
    if (where) place['name'] = where;
    if (geo) {
      place['geo'] = { '@type': 'GeoCoordinates', latitude: geo[0], longitude: geo[1] };
    }
    ld['location'] = place;
    ld['eventAttendanceMode'] = 'https://schema.org/OfflineEventAttendanceMode';
  }

  const image = ctx.adapter.policy.images ? imageOf(vevent) : null;
  if (image) ld['image'] = image;
  const page = (vevent.getFirstPropertyValue('url') as string | null) ?? ctx.calendarUrl;
  if (page) ld['url'] = page;
  const organizer: Record<string, unknown> = { '@type': 'Organization', name: ctx.calendarName };
  if (ctx.calendarUrl) organizer['url'] = ctx.calendarUrl;
  ld['organizer'] = organizer;
  const summary = summaryOf(vevent, ctx.adapter);
  if (summary) ld['description'] = summary;
  return ld;
}
