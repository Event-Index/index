// The time zone at a venue, from the time-zone boundaries (geo-tz, its full
// dataset, so a place is named by its own zone: Europe/Stockholm, not the
// zone it has shared a clock with since 1970).

import { find, setCache } from 'geo-tz/all';

// No boundary cell is kept in memory: a cell read from disk again costs less
// than a millisecond, and keeping those of every venue costs some 85 MB.
setCache({ store: { get: () => undefined, set: () => {} } });

// The zone at a point, or null off the map, at sea (Etc/GMT±n) or for a zone
// this runtime does not know.
export function zoneAt(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const zone = find(lat, lon)[0];
  if (!zone || zone.startsWith('Etc/')) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}
