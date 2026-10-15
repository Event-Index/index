// Luma (luma.com) feeds:
// - the event link is the first DESCRIPTION line, "Get up-to-date information at: <url>";
// - SEQUENCE is one number shared by every event, and STATUS is TENTATIVE on
//   everything, so only STATUS:CANCELLED is kept;
// - a venue shown only to registered guests appears as LOCATION = the event
//   page, with "Check event page for more details." as the address, while GEO
//   still carries the venue's coordinates. The index keeps no place for such
//   an event: what the organizer hid is not stored;
// - an account's default calendar is named "Personal", its description is
//   "Luma Calendar", and some events name "Luma Event" as organizer.

import type ICAL from 'ical.js';
import { RESERVED, type Adapter } from './types.ts';

const LINK_LINE = /^Get up-to-date information at: (\S+)[ \t]*(?:\n\n?|$)/;
const EVENT_PAGE = /^https?:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/event\/evt-[A-Za-z0-9]+\/?$/;
const HIDDEN_ADDRESS = /(?:^|\n)Address:\nCheck event page for more details\./;

function setText(vevent: ICAL.Component, name: string, value: string): void {
  if (value) vevent.updatePropertyWithValue(name, value);
  else vevent.removeAllProperties(name);
}

export const luma: Adapter = {
  source: 'luma',
  policy: RESERVED,
  descriptionFormat: 'text',
  isDefaultCalendarName: (name) => name.trim() === 'Personal',
  isDefaultCalendarDescription: (text) => text.trim() === 'Luma Calendar',
  isDefaultOrganizerName: (name) => name.trim() === 'Luma Event',

  event(vevent) {
    const description = vevent.getFirstPropertyValue('description');
    if (typeof description === 'string') {
      const match = LINK_LINE.exec(description);
      if (match) {
        if (!vevent.hasProperty('url')) vevent.addPropertyWithValue('url', match[1]!);
        setText(vevent, 'description', description.slice(match[0].length));
      }
    }
    vevent.removeAllProperties('sequence');
    const status = vevent.getFirstPropertyValue('status');
    if (typeof status === 'string' && status.toUpperCase() !== 'CANCELLED') vevent.removeAllProperties('status');

    const location = vevent.getFirstPropertyValue('location');
    const hidden = HIDDEN_ADDRESS.test(String(vevent.getFirstPropertyValue('description') ?? ''))
      || (typeof location === 'string' && EVENT_PAGE.test(location.trim()));
    if (hidden) {
      vevent.removeAllProperties('location');
      vevent.removeAllProperties('geo');
      vevent.updatePropertyWithValue('x-eventindex-venue', 'hidden');
    }
  },

  summaryText(plain) {
    return plain
      .replace(/^Address:\n(?:.+\n)*?(?:\n|$)/, '')
      .replace(/(?:^|\n\n)Hosted by .*$/, '')
      .trim();
  },
};
