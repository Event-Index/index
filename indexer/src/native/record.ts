// A native calendar's NIP-52 events as records, the bridge's other direction
// (spec/nip52-mapping.md § 7): each time-based (31923) or date-based (31922)
// event becomes a VEVENT. The events are written as one iCalendar feed and
// normalized like any other, so a native record, its public projections and
// the events table behave as a feed's do.

import ICAL from 'ical.js';
import '../ical/design.ts';
import { normalizeFeed, PRODID, type FeedContext, type LogEntry, type NormalizedFeed } from '../normalize/normalize.ts';
import { annotate, naddrFor, type Annotation } from '../project/annotate.ts';
import { CANCELLED_PREFIX } from '../project/nip52.ts';
import { decodeGeohash } from '../project/geohash.ts';
import { canonicalZone } from '../ical/zones.ts';

// A signed event as read from a relay.
export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

// An event and the relay it was read from, for the record's address hint.
export interface Found {
  event: NostrEvent;
  relay: string | null;
}

export interface NativeContext extends FeedContext {
  // The calendar's name, written as the feed's NAME.
  calendarName: string | null;
}

const tag = (event: NostrEvent, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1];
const tags = (event: NostrEvent, name: string): string[] => event.tags.filter((t) => t[0] === name && typeof t[1] === 'string').map((t) => t[1]!);

// A native event's UID: its address.
export function nativeUid(event: NostrEvent): string {
  return `${event.kind}:${event.pubkey}:${tag(event, 'd') ?? ''}`;
}

function wallClock(unix: number, zone: string): ICAL.Time {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ICAL.Time.fromData({ year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') });
}

const utc = (unix: number) => ICAL.Time.fromJSDate(new Date(unix * 1000), true);

// A 31923 time: in its IANA zone when it names one, else in UTC.
function timeProperty(name: string, unix: number, tzid: string | undefined): ICAL.Property {
  const property = new ICAL.Property(name);
  const zone = tzid ? canonicalZone(tzid) : null;
  if (zone) {
    property.setParameter('tzid', zone);
    property.setValue(wallClock(unix, zone));
  } else {
    property.setValue(utc(unix));
  }
  return property;
}

function dateOf(text: string | undefined): ICAL.Time | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

const SECONDS = /^\d{1,12}$/;

// One event as a VEVENT, or the reason it is left out.
function vevent(event: NostrEvent): ICAL.Component | LogEntry {
  const d = tag(event, 'd');
  if (d === undefined) return { code: 'no-uid', detail: event.id };
  const uid = nativeUid(event);
  let title = (tag(event, 'title') ?? '').trim() || (tag(event, 'name') ?? '').trim();
  if (!title) return { code: 'no-title', uid };
  const startText = tag(event, 'start');
  if (startText === undefined) return { code: 'no-start', uid };

  const out = new ICAL.Component('vevent');
  out.addPropertyWithValue('uid', uid);
  if (event.kind === 31922) {
    const start = dateOf(startText);
    if (!start) return { code: 'bad-value', uid, detail: 'start' };
    out.addPropertyWithValue('dtstart', start);
    const end = dateOf(tag(event, 'end'));
    if (end && end.compare(start) > 0) out.addPropertyWithValue('dtend', end);
  } else {
    if (!SECONDS.test(startText)) return { code: 'bad-value', uid, detail: 'start' };
    const start = Number(startText);
    const tzid = tag(event, 'start_tzid');
    out.addProperty(timeProperty('dtstart', start, tzid));
    const endText = tag(event, 'end');
    if (endText && SECONDS.test(endText) && Number(endText) > start) out.addProperty(timeProperty('dtend', Number(endText), tag(event, 'end_tzid') ?? tzid));
  }

  const cancelled = title.startsWith(CANCELLED_PREFIX) || (tag(event, 'status') ?? '').toLowerCase() === 'cancelled';
  if (title.startsWith(CANCELLED_PREFIX)) title = title.slice(CANCELLED_PREFIX.length).trim() || title;
  out.addPropertyWithValue('summary', title);
  const description = event.content.trim() || (tag(event, 'summary') ?? '').trim();
  if (description) out.addPropertyWithValue('description', description);
  if (cancelled) out.addPropertyWithValue('status', 'CANCELLED');

  const places = [...new Set(tags(event, 'location').map((l) => l.trim()).filter(Boolean))];
  if (places[0]) out.addPropertyWithValue('location', places[0]);
  for (const place of places.slice(1)) {
    const location = new ICAL.Component('vlocation');
    location.addPropertyWithValue('name', place);
    out.addSubcomponent(location);
  }
  const geo = decodeGeohash(tag(event, 'g') ?? '');
  if (geo) {
    const property = new ICAL.Property('geo');
    property.setValue([Number(geo[0].toFixed(6)), Number(geo[1].toFixed(6))]);
    out.addProperty(property);
  }
  const page = tags(event, 'r').find((r) => /^https?:\/\//i.test(r));
  if (page) out.addPropertyWithValue('url', page);
  const image = tag(event, 'image');
  if (image && /^https?:\/\//i.test(image)) out.addPropertyWithValue('image', image).setParameter('value', 'URI');
  const topics = [...new Set(tags(event, 't').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (topics.length) {
    const categories = new ICAL.Property('categories');
    categories.setValues(topics);
    out.addProperty(categories);
  }
  out.addPropertyWithValue('last-modified', utc(event.created_at));
  return out;
}

// The events (31922 and 31923 of one author) as a normalized feed, each
// record naming the event it came from (X-EVENTINDEX-NOSTR).
export function nativeFeed(found: Found[], ctx: NativeContext): NormalizedFeed {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);
  if (ctx.calendarName) calendar.addPropertyWithValue('name', ctx.calendarName);
  const skipped: LogEntry[] = [];
  const hints = new Map<string, Found>();
  const sorted = [...found]
    .filter((f) => f.event.kind === 31922 || f.event.kind === 31923)
    .sort((a, b) => (nativeUid(a.event) < nativeUid(b.event) ? -1 : nativeUid(a.event) > nativeUid(b.event) ? 1 : b.event.created_at - a.event.created_at));
  for (const f of sorted) {
    const result = vevent(f.event);
    if (result instanceof ICAL.Component) {
      calendar.addSubcomponent(result);
      const uid = nativeUid(f.event);
      const known = hints.get(uid);
      if (!known || f.event.created_at > known.event.created_at) hints.set(uid, f);
    } else {
      skipped.push(result);
    }
  }
  const feed = normalizeFeed(`${ICAL.stringify(calendar.toJSON())}\r\n`, ctx);
  for (const record of feed.records) {
    const f = hints.get(record.uid);
    if (!f) continue;
    const notes = new Map<string, Annotation>([[record.id, { nostr: naddrFor(f.event.pubkey, f.event.kind, tag(f.event, 'd') ?? '', f.relay ? [f.relay] : []) }]]);
    annotate(record, notes);
  }
  feed.log.push(...skipped);
  return feed;
}
