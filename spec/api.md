# API reference

Status: draft.

Base URL: `https://api.eventindex.space/api/1.0`. The version is part of every
path. Read endpoints need no key and send `Access-Control-Allow-Origin: *`.

## Identifiers

- **Calendar**: its directory entry's `d` ([`icalendar-profile.md`](icalendar-profile.md) § 5).
  In a path, a calendar is named by its local name (§ 5.1 there), which is
  URL-safe. The calendar key is its `guid`.
- **Event**: its public id, 32 characters of `a-z2-7`
  ([`icalendar-profile.md`](icalendar-profile.md) § 6). One URL per record or
  occurrence: `/events/byid/<id>`.

## Formats

| Suffix | Media type | Content |
|---|---|---|
| none | `application/calendar+json` | jCal (RFC 7265) |
| `.ics` | `text/calendar` | iCalendar (RFC 5545) |
| `.json` | `application/ld+json` | schema.org `Event` |

Projections follow the source's content policy
([`platform-adapters.md`](platform-adapters.md)) and never carry an `ORGANIZER`
or `ATTENDEE`. An event whose venue is hidden carries no place in any format.
An occurrence of a recurring event is served as that one instance (its
`RECURRENCE-ID` set, its rule removed).

Every response carries `Access-Control-Allow-Origin: *`. Times in parameters
are unix seconds.

## Read

### Calendars

| Request | Returns |
|---|---|
| `GET /calendars/byfeedurl?url=<feed URL>` | the entry whose feed URL, canonicalized, matches |
| `GET /calendars/byslug/<local name>` | one entry |
| `GET /calendars/byguid/<npub or hex>` | the entry of a calendar key |
| `GET /search/calendars/byterm?q=&near=<geohash>&tag=&limit=` | `{"calendars": [...], "count": n}`, removed entries left out |

`q` matches the name, description and area; `near` matches an entry whose area
geohash and `near` share a prefix (either holds the other); `tag` keeps
calendars with an event carrying that topic. `limit`: default 50, at most 500.

A calendar response:

```json
{
  "calendar": {
    "d": "meetup:pythonsd",
    "name": "San Diego Python Users Group",
    "role": "calendar",
    "source": "meetup",
    "feed": "https://www.meetup.com/pythonsd/events/ical/",
    "url": "https://www.meetup.com/pythonsd/",
    "description": null,
    "image": null,
    "location": "San Diego, US",
    "g": "9mud",
    "t": []
  },
  "eventindex": {
    "local_name": "meetup-pythonsd",
    "address": "39999:<index key>:meetup:pythonsd",
    "nostr": { "npub": "npub1…", "nip05": "meetup-pythonsd@eventindex.space", "calendar": "naddr1…" },
    "page": "https://eventindex.space/calendar/meetup-pythonsd",
    "ics": "https://api.eventindex.space/api/1.0/ics/calendar/meetup-pythonsd.ics",
    "last_indexed": 1792087200,
    "event_count": 4,
    "stale": false,
    "claimed": false,
    "removed": false
  }
}
```

`image` is null where the source's policy serves no images. `nostr` is null
until the calendar's first poll has created its key; `last_indexed` is the
last successful poll. A removed calendar is still answered by these lookups,
with `removed: true` and no events.

### Events

| Request | Returns |
|---|---|
| `GET /events/byid/<id>[.ics\|.json]` | one record or occurrence |
| `GET /events/bycalendar/<local name>[.json]?from=&to=&limit=` | a calendar's occurrences that overlap `from`–`to` (default: the projection window), soonest first |
| `GET /search/events/byterm[.json]?q=&from=&to=&near=<geohash>&radius=<km>&tag=&limit=` | matching occurrences, soonest first |

- `/events/byid/<id>` answers an occurrence by its id, and a record by the id
  of its master: for a recurring record, the whole series (in JSON-LD an
  `EventSeries` with its occurrences in the window as `subEvent`); for a past
  event the feed no longer lists, its last record. Without a suffix it is the
  record's jCal; the record carries `X-EVENTINDEX-ID`, and where they apply
  `X-EVENTINDEX-NOSTR` and `X-EVENTINDEX-CANONICAL`.
- Search: `from` defaults to now and `to` to a year after `from`. `q` matches
  the title, summary and place; `near` matches an event whose geohash starts
  with it, and an event without coordinates (a hidden venue, a feed without
  `GEO`) by its calendar's area; `radius` widens `near` to the geohash cell at
  least that many kilometres wide; `tag` matches a topic. `limit`: default
  100 (500 for a calendar), at most 500.

A list of events is `{"events": [...], "count": n}`. With `.json` each item is
a schema.org `Event`. Otherwise each item is:

```json
{
  "jcal": ["vcalendar", [...], [...]],
  "eventindex": {
    "id": "<public id>",
    "url": "https://api.eventindex.space/api/1.0/events/byid/<public id>",
    "start": 1792468800,
    "end": 1792476000,
    "nostr": "naddr1…",
    "calendar": "<calendar d>",
    "canonical": "<public id of the signing record, when this one is a co-host's copy>",
    "cohosts": ["<calendar d>"],
    "source": "meetup",
    "via": "<the calendar's feed URL>"
  }
}
```

`nostr` is the address the event is published at: for a co-host's copy, the
signing calendar's.

### Feeds

| Request | Returns |
|---|---|
| `GET /ics/calendar/<local name>.ics` | a calendar's records with an occurrence in the window, as one feed |
| `GET /ics/city/<city>.ics` | the records of the directory's calendars in a city, a co-hosted event once (from the calendar that signs it); never a copy of an aggregator's feed |

`<city>` is a slug from `seeds/cities.json`; a calendar is in the city when
its area is `<city name>, <country code>`.

### Directory and service

| Request | Returns |
|---|---|
| `GET /dump/index.db` | a nightly SQLite file: directory entries, calendar metadata and poll statistics. No event content. CC0 1.0. |
| `GET /stats` | counts of calendars, events and polls |
| `GET /.well-known/nostr.json?name=<local name>` (on `eventindex.space`) | NIP-05 names of calendar keys and of the index key (`_`) |

`/stats`:

```json
{
  "calendars": 103, "aggregators": 0, "removed": 0,
  "events": { "upcoming": 1870, "indexed": 2310 },
  "polls": { "ok_last_24h": 103, "failing": 0, "stale": 0 },
  "dump": { "url": "https://api.eventindex.space/api/1.0/dump/index.db", "generated_at": 1792103973 },
  "generated_at": 1792103986
}
```

NIP-05 answers `{"names": {"<name>": "<hex key>"}, "relays": {"<hex key>":
["wss://relay.eventindex.space"]}}`; names are matched case-insensitively.
Without `name` it answers `_`.

Every event response names its source in `eventindex.source` (or the record's
`X-EVENTINDEX-SOURCE`); responses about one calendar carry
`Link: <feed URL>; rel="via"`.

## Write

Writes need no key. They are limited per client address (10 submissions and
5 remove requests an hour) and take a JSON object or a form of at most
16 KiB. A remove request always waits for a maintainer; a submitted feed is
added at once when it is safe to, and otherwise waits for review.

| Request | Does |
|---|---|
| `POST /feeds/add` with `{"url": "<feed URL>"}` (or `?url=`) | validates the feed ([`indexer-rules.md`](indexer-rules.md) § 4), then adds it at once or queues it for review (§ 10 there) |
| `POST /calendars/<local name>/remove-request` with `{"message": "…"}` (optional, at most 1,000 characters) | records a request to remove the calendar, for review |

`/feeds/add` answers `201` with
`{"status": "approved", "submission": n, "d", "local_name", "name", "source", "role", "page", "message"}`
when the calendar is added at once, and `202` with
`{"status": "queued" | "already-queued", "submission": n, "d", "name", "source", "role", "message"}`
when it waits for review. Once approved, by the index or a maintainer, the
entry is filed and the next poll (within a minute) creates its calendar key
and publishes its events.

`/remove-request` answers `202` with
`{"status": "received", "request": n, "d", "token": "eventindex-remove-…", "instructions": "…"}`.
The token is the organizer's proof: placed in the calendar's description or
in one of its events, it is found at the next poll and marks the request
verified. A maintainer approves or rejects each request; an approved removal
is carried out as [`indexer-rules.md`](indexer-rules.md) § 10 describes.

The pages of `eventindex.space` post the same requests as forms
(`POST /submit`, `POST /calendar/<local name>/remove`) and answer in HTML.

Errors are `{"error": "<code>", "message": "<text>"}` with an HTTP status:

| Status | Codes |
|---|---|
| 400 | `invalid-url`, `unsupported-feed`, `private-feed-url`, `invalid-parameter`, `invalid-body`, `invalid-message`, `too-long` |
| 404 | `not-found` |
| 405 | `method-not-allowed` |
| 409 | `already-listed` (with `d` and `local_name`), `not-indexed` (removed at its organizer's request) |
| 410 | `removed` |
| 413 | `too-large` (the request body) |
| 422 | the feed could not be used: `private-address`, `too-large`, `not-icalendar`, `empty`, `dns`, `timeout`, `too-many-redirects`, `http-<status>` |
| 429 | `rate-limited` (with `Retry-After`), `too-many-requests` (a calendar with 10 requests waiting) |
| 503 | `queue-full` (1,000 submissions waiting) |

nostr developers can also add to the index by publishing: a directory entry
(kind `39999`) under their own key, or NIP-52 events that the index reads by
kind.

## Attribution and data terms

- **Directory data** (entries, calendar metadata, poll statistics, seed lists)
  is in the public domain (CC0 1.0).
- **Event content is not licensed by the index.** Titles, descriptions, images
  and the rest of a record belong to the event's organizer and are subject to
  the terms of the platform the feed comes from.
- Every event response names its source platform (`eventindex.source`), links
  the event's own page (`URL` in iCalendar, `url` in JSON-LD), and carries
  `Link: <feed URL>; rel="via"`. Keep that attribution and the link when you
  show event content.
- For sources whose terms reserve event content (Luma, Meetup), responses carry
  titles, times, places, a summary of at most 280 characters and the link to
  the event's page; full descriptions and images are not served
  ([`platform-adapters.md`](platform-adapters.md)). Do not copy or re-host a
  platform's images.
- Platform names are used only to say where an event comes from, styled as
  their owners style them (Meetup®). The index is not affiliated with, or
  endorsed by, any platform it reads.
- An event whose venue its organizer shows only to registered guests carries
  no place in any response; `near` matches it by its calendar's area.
- An organizer can have their calendar removed from the index
  (`https://eventindex.space/calendar/<local name>`).
