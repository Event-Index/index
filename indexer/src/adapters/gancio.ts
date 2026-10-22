// Gancio instance feeds: one community's shared agenda, with no calendar
// name, no ORGANIZER, no GEO and no images. Public projections carry the
// summary and the link back: an instance's events stay their submitters'
// (spec/platform-adapters.md, Content policy).

import { RESERVED, type Adapter } from './types.ts';

export const gancio: Adapter = {
  source: 'gancio',
  policy: RESERVED,
  descriptionFormat: 'text',
};
