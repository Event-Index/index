// Per-address rate limits for the write endpoints, in memory only: the
// addresses are never written anywhere and are forgotten when their window
// ends.

export interface Limits {
  submitsPerHour: number;
  removeRequestsPerHour: number;
  // Pending submissions the review queue holds at most.
  queueCap: number;
  // Pending remove requests one calendar holds at most.
  removeRequestsPerCalendar: number;
  maxBodyBytes: number;
  maxMessageLength: number;
}

export const LIMITS: Limits = {
  submitsPerHour: 10,
  removeRequestsPerHour: 5,
  queueCap: 1000,
  removeRequestsPerCalendar: 10,
  maxBodyBytes: 16 * 1024,
  maxMessageLength: 1000,
};

const HOUR = 3600;
const MAX_TRACKED = 50_000;

export function rateLimiter() {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    // Counts one request; returns the seconds to wait when over the limit.
    take(key: string, perHour: number, now: number): number | null {
      if (windows.size > MAX_TRACKED) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      }
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + HOUR };
        windows.set(key, w);
      }
      if (w.count >= perHour) return Math.max(1, w.resetAt - now);
      w.count += 1;
      return null;
    },
  };
}

export type RateLimiter = ReturnType<typeof rateLimiter>;
