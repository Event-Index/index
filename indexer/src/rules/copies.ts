// Copies and their originals across calendars of different kinds. An
// organizer's own event (published from their own nostr key) is the
// original of the same event as a mirrored feed lists it, and either is the
// original of an aggregator's copy. The same event: starts within half an
// hour of each other, the same title (case, accents, punctuation and a
// "Cancelled: " prefix aside; or, for long titles, one holding the other),
// and, when both carry coordinates, within about five kilometres.
// Deterministic, so a rebuild gives the same answer.

// Ranks: who is more original.
export const AGGREGATOR = 0;
export const FEED = 1;
export const ORGANIZER = 2;

export interface Candidate {
  id: string;
  calendarD: string;
  rank: typeof AGGREGATOR | typeof FEED | typeof ORGANIZER;
  start: number;
  title: string;
  g: string | null;
}

export const START_TOLERANCE = 1800;
// Geohash cells of 5 characters are about 4.9 km by 4.9 km.
const NEAR_PRECISION = 5;
const CONTAINED_MIN = 12;

export function normalTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*cancelled:\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function sameTitle(a: string, b: string): boolean {
  const x = normalTitle(a);
  const y = normalTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= CONTAINED_MIN && ` ${long} `.includes(` ${short} `);
}

function near(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const n = Math.min(a.length, b.length, NEAR_PRECISION);
  return a.slice(0, n) === b.slice(0, n);
}

// Each copy's id, with the id of the original it yields to.
export function findCopies(rows: Candidate[]): Map<string, string> {
  const copies = new Map<string, string>();
  const byStart = [...rows].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  for (let i = 0; i < byStart.length; i += 1) {
    const row = byStart[i]!;
    if (row.rank === ORGANIZER) continue;
    let best: Candidate | null = null;
    // Neighbours within the tolerance, both ways.
    for (const step of [-1, 1]) {
      for (let j = i + step; j >= 0 && j < byStart.length; j += step) {
        const other = byStart[j]!;
        if (Math.abs(other.start - row.start) > START_TOLERANCE) break;
        if (other.rank <= row.rank || other.calendarD === row.calendarD) continue;
        if (!sameTitle(row.title, other.title) || !near(row.g, other.g)) continue;
        const better = !best || other.rank > best.rank
          || (other.rank === best.rank && (Math.abs(other.start - row.start) < Math.abs(best.start - row.start)
            || (Math.abs(other.start - row.start) === Math.abs(best.start - row.start) && other.id < best.id)));
        if (better) best = other;
      }
    }
    if (best) copies.set(row.id, best.id);
  }
  return copies;
}
