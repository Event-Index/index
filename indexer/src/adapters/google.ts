// Public Google calendars: HTML descriptions, VALARMs left in by the
// organizer's clients, X-WR-TIMEZONE, and on many calendars a description
// that is one link to the event's page and no URL property.

import { links, looksLikeHtml } from '../ical/text.ts';
import { RESERVED, type Adapter } from './types.ts';

export const google: Adapter = {
  source: 'google',
  policy: RESERVED,
  descriptionFormat: 'text',

  event(vevent) {
    if (vevent.hasProperty('url')) return;
    const description = vevent.getFirstPropertyValue('description');
    if (typeof description !== 'string' || !looksLikeHtml(description)) return;
    const found = [...new Set(links(description))];
    if (found.length === 1 && /^https?:\/\//i.test(found[0]!)) vevent.addPropertyWithValue('url', found[0]!);
  },
};
