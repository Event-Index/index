const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
    throw new RangeError(`not a coordinate: ${lat}, ${lon}`);
  }
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let hash = '';
  let bits = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lonRange : latRange;
    const coordinate = even ? lon : lat;
    const mid = (range[0]! + range[1]!) / 2;
    value <<= 1;
    if (coordinate >= mid) {
      value |= 1;
      range[0] = mid;
    } else {
      range[1] = mid;
    }
    if (even) lonRange = range;
    else latRange = range;
    even = !even;
    bits += 1;
    if (bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

// The centre of a geohash's cell, as [latitude, longitude]; null for a
// string that is not a geohash.
export function decodeGeohash(hash: string): [number, number] | null {
  if (!hash || !/^[0-9b-hjkmnp-z]+$/.test(hash)) return null;
  const lat = [-90, 90];
  const lon = [-180, 180];
  let even = true;
  for (const char of hash) {
    const value = BASE32.indexOf(char);
    for (let bit = 4; bit >= 0; bit -= 1) {
      const range = even ? lon : lat;
      const mid = (range[0]! + range[1]!) / 2;
      if ((value >> bit) & 1) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return [(lat[0]! + lat[1]!) / 2, (lon[0]! + lon[1]!) / 2];
}
