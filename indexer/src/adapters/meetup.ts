// Meetup group feeds carry URL and VTIMEZONE, no GEO and no LOCATION. Each
// DESCRIPTION starts with the group's name on a line of its own and is
// written in Markdown.

import { RESERVED, type Adapter } from './types.ts';

export const meetup: Adapter = {
  source: 'meetup',
  policy: RESERVED,
  // Meetup hosts its events' images under its own terms.
  imagesOnceVerified: false,
  descriptionFormat: 'markdown',

  event(vevent, calendar) {
    const description = vevent.getFirstPropertyValue('description');
    if (typeof description !== 'string' || !calendar.name) return;
    const [first, ...rest] = description.split('\n');
    if (first?.trim() === calendar.name.trim()) {
      const remaining = rest.join('\n').replace(/^\n+/, '');
      if (remaining) vevent.updatePropertyWithValue('description', remaining);
      else vevent.removeAllProperties('description');
    }
  },
};
