# seeds

Lists of organizer calendars to file in the directory, by platform and city.
Seed lists are directory data, dedicated to the public domain under CC0 1.0
(see [`LICENSE`](LICENSE)).

## Format

`cities.json` lists the cities the seed lists cover (US cities with more than
1,000,000 residents; then, marked `"wave": 2`, US cities with a Luma Discover
page; then, marked `"wave": 3`, every other place with a Luma Discover page,
worldwide, each by the GeoNames populated place of its name), each with its GeoNames id, coordinates, IANA time zone, Luma Discover
page when it has one (`luma_discover`, the place's `luma:discplace-…` id, and
`luma_slug`, the page's address at `https://luma.com/<slug>`) and seed files.

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
  - `submission`: submitted through the index and approved;
  - `luma:discover`: on an aggregator, the list of Luma Discover places
    (`https://luma.com/discover`).

City identifiers are GeoNames ids (geonames.org, CC BY 4.0).

## Filing a seed list

`eventindex-admin import-seeds` files each listed calendar in the directory,
in the city's area, unless it is listed already or on the do-not-index list;
the poll service then reads its feed and publishes its entry and its events.
It reports how many it filed, how many were listed already and which it left
out.

```sh
eventindex-admin import-seeds seeds/luma/new-york.json seeds/meetup/new-york.json
```

## The communities list

`communities.json` is a hand-kept list of bitcoin venues and communities:

```json
{
  "communities": [
    { "name": "Bitcoin Park Nashville", "city": "nashville", "source": "meetup", "id": "bitcoinpark", "found_via": "hand-kept" },
    { "name": "Fork & Coin", "city": "chicago", "source": "nostr", "pubkey": "8bcb…ddb1",
      "organization": "Chicago Bitcoin Collective", "note": "…", "found_via": "hand-kept" }
  ]
}
```

- `name`: the organization's name, as it gives it; `city`: a slug from
  `cities.json`, whose area the entry takes.
- `source` and `id`: a Luma calendar id or a Meetup group, as in the seed
  lists; or `feed`, a feed URL, for any other source.
- `source` `nostr` with `pubkey`: a community that publishes its NIP-52 events
  from its own key. Importing the list does not file it: the index lists it
  from its events once it has an upcoming one
  ([`../spec/indexer-rules.md`](../spec/indexer-rules.md) § 14), or its
  organizer files it with their key; the index never holds a key for it.

`eventindex-admin import-seeds seeds/communities.json` files the ones with a
feed, like a seed list.

## The aggregators

`eventindex-admin import-aggregators [--only <slug>,...]` files the Luma
Discover page of each city in `cities.json` that has one (or of the cities
named, by their slug or the page's) as an `aggregator` entry: no key, its
events never projected. The poll service reads each page every six hours and
files the named public calendars of its events, found via the page's `d`
(`../spec/indexer-rules.md` § 2); `eventindex-admin discoveries [--hours <n>]`
lists what it filed, skipped and refused.

## Gancio instances

`gancio.json` lists Gancio instances from the project's list at
`gancio.org/instances` whose instance-wide feed robots.txt allows and the
index can read. `eventindex-admin import-gancio seeds/gancio.json` files
each as one community calendar, named for the instance, under the area
given it by hand: its city, `Worldwide`, or none
(`../spec/platform-adapters.md`, Gancio). `held` lists instances left out,
with why.

```json
{
  "instances": [{ "host": "bcn.convoca.la", "name": "Convoca-la BCN", "feed": "https://bcn.convoca.la/feed/ics", "location": "Barcelona, ES", "g": "sp3e" }],
  "held": [{ "host": "example.org", "reason": "…" }]
}
```

## Mobilizon groups

`mobilizon.json` lists Mobilizon public groups with upcoming events, each
from its own instance in the directory at `instances.mobilizon.org`, with the
area the group states (or none). `eventindex-admin import-mobilizon
seeds/mobilizon.json` files them (`../spec/platform-adapters.md`, Mobilizon).
Held out of it: `ticketzon.it` (one operator's ticketed listings),
`rollenspiel.events` (its terms not yet read) and
`mobilisons.ch/@concert_cloud_switzerland` (an aggregator).

```json
{ "groups": [{ "instance": "mobilizon.fr", "group": "lyontechhub", "name": "Lyon Tech Hub", "feed": "https://mobilizon.fr/@lyontechhub/feed/ics", "location": "Lyon, FR", "g": "u05k" }] }
```

## Luma listing pages

`luma-pages.json` lists the Luma pages discovery reads besides the city
pages: each category page and `/discover`. They are discovery inputs only,
with no directory entry: the poll service reads each every six hours and
files the named public calendars they show, each under the area the
calendar states, or `Worldwide` (`../spec/indexer-rules.md` § 2). Their
lists, order and featuring are never kept or published.

```json
{ "pages": [{ "slug": "tech", "url": "https://luma.com/tech" }] }
```

## nostr aggregators

`nostr-aggregators.json` lists nostr keys that publish other organizers'
events under their own key. When the index lists the publishers of NIP-52
events ([`../spec/indexer-rules.md`](../spec/indexer-rules.md) § 14), each of
these keys gets an entry with the role `aggregator`: its events are kept and
attributed to it, and an organizer's own original of one of them is the
canonical one (§ 15 there).
