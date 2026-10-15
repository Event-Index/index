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
