// Which directory entries the index polls and projects.

import type { Role } from '../types.ts';

// Entries filed by the index key itself (seeded and submitted ones, after
// validation), unless removed.
export function isPolled(entry: { author: string; removed: boolean }, indexPubkey: string): boolean {
  return entry.author === indexPubkey && !entry.removed;
}

// An aggregator only leads to calendars; its events are never projected.
export function isProjected(entry: { role: Role }): boolean {
  return entry.role === 'calendar';
}
