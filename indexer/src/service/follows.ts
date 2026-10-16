// The index key's follow list (kind 3) names the calendar keys it holds. Relays
// keep a list of at most 2,000 tags, so it stops short of that: past the cap,
// the calendars filed first stay followed and later ones are not added.

export const FOLLOW_CAP = 1900;
// The share of the cap at which the index says it is near.
export const FOLLOW_NEAR = 0.9;

export function followed(entries: Array<{ d: string; pubkey: string | null; addedAt: number }>, cap: number): string[] {
  return entries
    .filter((e): e is { d: string; pubkey: string; addedAt: number } => !!e.pubkey)
    .sort((a, b) => a.addedAt - b.addedAt || (a.d < b.d ? -1 : 1))
    .slice(0, cap)
    .map((e) => e.pubkey)
    .sort();
}
