// Mobilizon group feeds: TZID without VTIMEZONE, long lines left unfolded, an
// ORGANIZER that is the group's name rather than a calendar address, empty
// LOCATION on online events, the banner as an image ATTACH, and Markdown
// descriptions with backslash escapes. Public projections carry the summary
// and the link back, as for Luma and Meetup: a group's descriptions and
// images stay the group's (spec/platform-adapters.md, Content policy).

import { RESERVED, type Adapter } from './types.ts';

export const mobilizon: Adapter = {
  source: 'mobilizon',
  policy: RESERVED,
  descriptionFormat: 'markdown',
};
