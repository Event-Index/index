// What a Meetup event page states about its event, read from its schema.org
// Event JSON-LD (`<script type="application/ld+json">`) and nothing else: not
// the page's app data, which carries the venue's coordinates. A venue is
// taken as text (its name, street address and locality) only when the page
// shows it to a logged-out reader; an online event is "Online"
// (spec/platform-adapters.md, Meetup).

export interface PageFacts {
  // The venue as text, "Online", or null when the page shows none.
  location: string | null;
  cancelled: boolean;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_JSON = /\btype\s*=\s*["']?application\/ld\+json\b/i;
// Names a page gives a venue it does not show, or does not have yet.
const NO_VENUE = /visible to (?:members|attendees)|members only|needs a location|^(?:tba|tbd|to be (?:announced|determined))$/i;
const MAX_LOCATION = 300;

type Node = Record<string, unknown>;

function* nodes(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const v of value) yield* nodes(v);
  } else if (value && typeof value === 'object') {
    const node = value as Node;
    if ('@graph' in node) yield* nodes(node['@graph']);
    yield node;
  }
}

const typesOf = (node: Node) => [node['@type']].flat().filter((t): t is string => typeof t === 'string');
const term = (value: unknown) => (typeof value === 'string' ? value.replace(/^https?:\/\/schema\.org\//, '') : '');
const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

function venueText(place: Node | string): string | null {
  const name = clean(typeof place === 'string' ? place : place['name']);
  const address = typeof place === 'string' ? null : place['address'];
  const street = typeof address === 'string' ? clean(address) : clean((address as Node | null)?.['streetAddress']);
  const locality = address && typeof address === 'object' ? clean((address as Node)['addressLocality']) : '';
  let text = '';
  for (const part of [NO_VENUE.test(name) ? '' : name, street, locality]) {
    if (!part || text.toLowerCase().includes(part.toLowerCase())) continue;
    // A part that holds the text so far (a name that is the street) takes its place.
    text = !text || part.toLowerCase().includes(text.toLowerCase()) ? part : `${text}, ${part}`;
  }
  return text ? text.slice(0, MAX_LOCATION).trim() : null;
}

export function readEventPage(html: string): PageFacts | null {
  for (const [, attributes, body] of html.matchAll(SCRIPT)) {
    if (!LD_JSON.test(attributes!)) continue;
    let data: unknown;
    try {
      data = JSON.parse(body!.trim());
    } catch {
      continue;
    }
    for (const node of nodes(data)) {
      if (!typesOf(node).some((t) => t === 'Event' || t.endsWith('Event'))) continue;
      const status = term(node['eventStatus']);
      const mode = term(node['eventAttendanceMode']);
      const places = [node['location']].flat()
        .filter((l): l is Node | string => typeof l === 'string' || (!!l && typeof l === 'object' && !typesOf(l as Node).includes('VirtualLocation')));
      const venue = places.map(venueText).find(Boolean) ?? null;
      const online = status === 'EventMovedOnline' || mode === 'OnlineEventAttendanceMode';
      return { location: online ? 'Online' : venue, cancelled: status === 'EventCancelled' };
    }
  }
  return null;
}
