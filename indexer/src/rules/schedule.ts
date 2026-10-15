// When each feed is polled next.

export const BASE_INTERVAL = 6 * 3600;
export const HOT_INTERVAL = 3600;
export const HOT_WINDOW = 48 * 3600;
export const MAX_INTERVAL = 24 * 3600;
export const FIRST_BACKOFF = 15 * 60;
export const STALE_AFTER = 14 * 86400;

export interface ScheduleInput {
  now: number;
  // The feed's REFRESH-INTERVAL (or X-PUBLISHED-TTL), seconds.
  refreshInterval: number | null;
  nextEventStart: number | null;
  // Consecutive failed polls, 0 after a success.
  failures: number;
  // The server's Retry-After, seconds from now.
  retryAfter: number | null;
}

// Every 6 hours, or every hour while an event starts within 48 hours, never
// more often than the feed's REFRESH-INTERVAL (honored up to a day). After a
// failure: 15 minutes, doubling to a day, and never before Retry-After.
export function nextPollAt(input: ScheduleInput): number {
  let delay: number;
  if (input.failures > 0) {
    delay = Math.min(FIRST_BACKOFF * 2 ** (input.failures - 1), MAX_INTERVAL);
  } else {
    const hot = input.nextEventStart !== null && input.nextEventStart >= input.now && input.nextEventStart - input.now < HOT_WINDOW;
    delay = Math.min(Math.max(input.refreshInterval ?? 0, hot ? HOT_INTERVAL : BASE_INTERVAL), MAX_INTERVAL);
  }
  if (input.retryAfter !== null) delay = Math.max(delay, input.retryAfter);
  return input.now + delay;
}

export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round(date / 1000 - now));
}

export function isStale(input: { now: number; firstFailureAt: number | null }): boolean {
  return input.firstFailureAt !== null && input.now - input.firstFailureAt >= STALE_AFTER;
}
