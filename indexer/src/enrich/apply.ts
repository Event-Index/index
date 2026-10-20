// What a Meetup event page adds to the event's record: a venue as LOCATION
// text where the feed gives no place, and STATUS:CANCELLED where the page
// says the event is cancelled. Applying is worked out from what the feed
// itself said, so it can be done again, or undone, on a record that already
// holds a page's values. X-EVENTINDEX-ENRICHED names the page and, in
// X-EVENTINDEX-PROPERTIES, what it gave (spec/icalendar-profile.md § 3.5).

import ICAL from 'ical.js';
import type { PageFacts } from './event-page.ts';

// An event's page: /<group>/events/<id>/, the id numbers or letters, not
// one of the group's feeds.
const EVENT_PAGE = /^https:\/\/(?:www\.)?meetup\.com\/[A-Za-z0-9_-]+\/events\/(?!(?:ical|rss|atom|xml|past|calendar)\/?$)[A-Za-z0-9]+\/?$/;
const MARKER = 'x-eventindex-enriched';
const PROPERTIES = 'x-eventindex-properties';

export const isMeetupEventPage = (url: string) => EVENT_PAGE.test(url);

// What the feed said, kept for each event read from a page.
export interface FeedSays {
  location: string | null;
  status: string | null;
  // LAST-MODIFIED and SEQUENCE: a change has the page read again.
  stamp: string;
}

export function feedSays(vevent: ICAL.Component): FeedSays {
  const location = String(vevent.getFirstPropertyValue('location') ?? '').trim();
  const status = vevent.getFirstPropertyValue('status');
  const modified = vevent.getFirstPropertyValue('last-modified');
  return {
    location: location || null,
    status: typeof status === 'string' && status ? status.toUpperCase() : null,
    stamp: `${modified ? String(modified) : ''}|${vevent.getFirstPropertyValue('sequence') ?? ''}`,
  };
}

export function applyPage(vevent: ICAL.Component, feed: FeedSays, facts: PageFacts | null, page: string): void {
  vevent.removeAllProperties(MARKER);
  const given: string[] = [];
  if (feed.location === null) {
    vevent.removeAllProperties('location');
    if (facts?.location) {
      vevent.addPropertyWithValue('location', facts.location);
      given.push('LOCATION');
    }
  }
  if (facts?.cancelled && feed.status !== 'CANCELLED') {
    vevent.updatePropertyWithValue('status', 'CANCELLED');
    given.push('STATUS');
  } else if (feed.status) {
    vevent.updatePropertyWithValue('status', feed.status);
  } else {
    vevent.removeAllProperties('status');
  }
  if (given.length === 0) return;
  const marker = new ICAL.Property(MARKER);
  marker.setValue(page);
  marker.setParameter(PROPERTIES, given.join(','));
  vevent.addProperty(marker);
}
