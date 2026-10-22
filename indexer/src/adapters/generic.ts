import { OPEN, RESERVED, type Adapter } from './types.ts';
import type { Source } from '../types.ts';

// A feed filed on its own is served as summary and link, as every source is,
// until its organizer verifies; an organizer's own nostr events as they
// published them.
export function generic(source: Source): Adapter {
  return { source, policy: source === 'nostr' ? OPEN : RESERVED, descriptionFormat: 'text' };
}
