// Mobilizon group feeds: TZID without VTIMEZONE, long lines left unfolded, an
// ORGANIZER that is the group's name rather than a calendar address, empty
// LOCATION on online events, the banner as an image ATTACH, and Markdown
// descriptions with backslash escapes.

import { OPEN, type Adapter } from './types.ts';

export const mobilizon: Adapter = {
  source: 'mobilizon',
  policy: OPEN,
  descriptionFormat: 'markdown',
};
