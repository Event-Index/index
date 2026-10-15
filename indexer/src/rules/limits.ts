// Limits on what one calendar key publishes, and created_at for bulk
// publishes.

export const MAX_EVENTS_PER_CALENDAR = 10_000;
export const MAX_PER_SECOND = 1000;

export function capPerCalendar<T extends { start: number }>(items: T[], max = MAX_EVENTS_PER_CALENDAR): { kept: T[]; dropped: number } {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  return { kept: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

// Relays page by created_at and cannot page past one second holding more
// than their limit, so a bulk publish spreads created_at backwards from now,
// at most `perSecond` to a second. A new version of an event is always later
// than its last published version.
export function spreadCreatedAt(items: Array<{ key: string; last: number | null }>, now: number, perSecond = MAX_PER_SECOND): Map<string, number> {
  const assigned = new Map<string, number>();
  items.forEach((item, i) => {
    const spread = now - Math.floor(i / perSecond);
    assigned.set(item.key, item.last !== null && item.last >= spread ? item.last + 1 : spread);
  });
  return assigned;
}
