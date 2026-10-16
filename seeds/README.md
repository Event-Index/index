# seeds

Lists of organizer calendars to file in the directory, by platform and city.
Seed lists are directory data, dedicated to the public domain under CC0 1.0
(see [`LICENSE`](LICENSE)).

## Format

`cities.json` lists the cities the seed lists cover (US cities with more than
1,000,000 residents; then, marked `"wave": 2`, US cities with a Luma Discover
page), each with its GeoNames id, coordinates, IANA time zone, Luma Discover
page (when it has one) and seed files.

One JSON file per platform and city, `seeds/<source>/<city-slug>.json`:

```json
{
  "city": "New York",
  "country": "US",
  "geonames_id": 5128581,
  "source": "luma",
  "found_via": "luma:discplace-Izx1rQVSh8njYpP",
  "found_at": "2026-10-15",
  "calendars": ["cal-BvuRd9eaZnDGBwy", { "id": "cal-ZGCxlwslp1K0wqD", "found_via": "btcmap:freedomlab-nyc" }],
  "skipped": [{ "id": "cal-EpqkMBrIPXa045L", "reason": "platform-default-calendar" }]
}
```

- `calendars`: platform ids of calendars an organizer created and named (a
  Luma calendar id, a Meetup urlname). Each becomes a directory entry with
  `d` = `<source>:<id>` (see `../spec/icalendar-profile.md`, "Directory
  identity"). An item is an id, or an object with the id and its own
  `found_via`.
- `skipped`: calendars found but not filed, with the reason:
  `platform-default-calendar` (Luma's "Personal": it enters the directory only
  when its owner submits or claims it, or a maintainer reviews it as an
  organization's), or the HTTP status its feed answered with.
- `reviewed`: on a `calendars` item, the date a maintainer reviewed a platform
  default calendar and found it to be an organization's. Such an item is filed
  like a named calendar, `{ "id": "cal-…", "found_via": "…", "reviewed": "YYYY-MM-DD" }`,
  and leaves `skipped`.
- `found_via`: where the list (or an item) was found, and `found_at` the date:
  - `luma:discplace-…`: the Luma Discover page of the city, whose page data
    names the calendar of each event it shows;
  - `btcmap:<area id>`: a BTC Map community (btcmap.org) named for the city or
    within 50 km of it, by its `contact:luma` or `contact:meetup` link;
  - `maintainer`: added by a maintainer;
  - `submission`: submitted through the index and approved.

City identifiers are GeoNames ids (geonames.org, CC BY 4.0).

## Filing a seed list

`scripts/seed-entries.ts` fetches and validates each listed calendar's feed,
skips platform default calendars, creates each filed calendar's key in the
vault, and writes the directory entries, unsigned and with `created_at`
spread, one JSON event per line, for the index key to sign. Each calendar's
outcome (`filed`, `skipped`, `refused` with its reason) goes to stderr.

```sh
CALENDAR_KEY_SECRET=<64 hex digits> node scripts/seed-entries.ts seeds/luma/new-york.json \
  --index-pubkey <hex> --vault vault.db > entries.jsonl
```
