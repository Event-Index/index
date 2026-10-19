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
| `GET /calendars/byguid/<npub or hex>` | the entry of a calendar key, or of an organizer's own key |
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
    "listed": true,
    "address": "39999:<index key>:meetup:pythonsd",
    "nostr": { "npub": "npub1…", "nip05": "meetup-pythonsd@eventindex.space", "calendar": "naddr1…" },
    "publishing": "mirrored",
    "page": "https://eventindex.space/calendar/meetup-pythonsd",
    "ics": "https://api.eventindex.space/api/1.0/ics/calendar/meetup-pythonsd.ics",
    "last_indexed": 1792087200,
    "event_count": 4,
    "stale": false,
    "claimed": false,
    "claimed_at": null,
    "removed": false
  }
}
```

`image` is null where the source's policy serves no images. `nostr` is the
key the calendar's events are signed with now; it is null until the
calendar's first poll has created its key. `publishing` says who signs them
([`directory.md`](directory.md)): `mirrored` (a calendar key the index
holds), `organizer` (the organizer, from their own key; the index reads their
events, `source` is `nostr` and `feed` null), or `delegated` (the index, as
the organizer, through their signer). For an organizer's key, `nostr.nip05`
is null (the index names no key it does not hold) and `nostr.calendar` is the
31924 the entry names, if any. `claimed` and `claimed_at` say whether and
when its organizer claimed it. `last_indexed` is the last successful poll or
read. A removed calendar is still answered by these lookups, with
`removed: true` and no events. A nostr publisher kept without a listing
([`indexer-rules.md`](indexer-rules.md) § 14) is answered too, with
`listed: false` and `address` null; the lists, search and counts leave it
out.

### Events

| Request | Returns |
|---|---|
| `GET /events/byid/<id>[.ics\|.json]` | one record or occurrence |
| `GET /events/bycalendar/<local name>[.json]?from=&to=&limit=` | a calendar's occurrences that overlap `from`–`to` (default: the projection window), soonest first |
| `GET /search/events/byterm[.json]?q=&from=&to=&near=<geohash>&radius=<km>&tag=&limit=` | matching occurrences, soonest first |

- `canonical` is the public id of the event this one copies: a co-host's
  copy, a feed's or an aggregator's copy of an organizer's own event, or an
  aggregator's copy of a feed's ([`indexer-rules.md`](indexer-rules.md) § 15).
- `/events/byid/<id>` answers an occurrence by its id, and a record by the id
  of its master: for a recurring record, the whole series (in JSON-LD an
  `EventSeries` with its occurrences in the window as `subEvent`); for a past
  event the feed no longer lists, its last record. Without a suffix it is the
  record's jCal; the record carries `X-EVENTINDEX-ID`, and where they apply
  `X-EVENTINDEX-NOSTR`, `X-EVENTINDEX-CANONICAL` and `X-EVENTINDEX-CLAIMED`.
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
    "canonical": "<public id of the event this one copies, if any>",
    "cohosts": ["<calendar d>"],
    "source": "meetup",
    "via": "<the calendar's feed URL>"
  }
}
```

`nostr` is the address the event is published at: for a co-host's copy, the
signing calendar's; for a calendar its organizer publishes, their event's.

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
| `POST /feeds/add` with `{"url": "<link>"}` (or `?url=`) | resolves the link (below), validates the feed ([`indexer-rules.md`](indexer-rules.md) § 4), then adds it at once or queues it for review (§ 10 there); or lists a nostr publisher at once |
| `POST /calendars/<local name>/remove-request` with `{"message": "…"}` (optional, at most 1,000 characters) | records a request to remove the calendar, for review; signed with the calendar's own key (below), carries it out at once |

`/feeds/add` takes whatever link people paste, and resolves it:

| Link | Resolves to |
|---|---|
| a Meetup group's page, its `/events/` page, or an event's page (`/<group>/events/<id>/`) | the group's feed, `https://www.meetup.com/<group>/events/ical/` |
| a Luma calendar (`luma.com/calendar/cal-…`) | its feed |
| a Luma vanity page (`luma.com/<name>`) or an event's page | the calendar named in the page's own data, read once through the same guarded fetch and size cap as feeds |
| a Google Calendar embed (`?src=<id>`) or share (`?cid=`) link | the calendar's public feed; a private address is refused |
| a Mobilizon group's page (`/@<group>`) | its feed, `/@<group>/feed/ics` |
| an npub, an nprofile (with or without `nostr:`), or a NIP-05 address | a nostr publisher, listed at once when its relays hold an upcoming NIP-52 event from it, kept without a listing when they hold only past ones |
| anything else | a feed address, as given |

For a feed it answers `201` with
`{"status": "approved", "submission": n, "d", "local_name", "name", "source", "role", "page", "found", "message"}`
when the calendar is added at once, and `202` with
`{"status": "queued" | "already-queued", "submission": n, "d", "name", "source", "role", "found", "message"}`
when it waits for review; `found` says in plain words what was found
(`Found the Meetup group "…".`). Once approved, by the index or a maintainer,
the entry is filed under the index key and the next poll (within a minute)
creates its calendar key and publishes its events. For a nostr publisher it
answers `201` with
`{"status": "listed", "d": "nostr:<hex key>", "local_name", "name", "events": n, "found", "message"}`,
or, when none of its events is upcoming, `202` with the same fields and
`"status": "kept"`: the index serves its events and lists it once it has an
upcoming one ([`indexer-rules.md`](indexer-rules.md) § 14).
A refused link answers with a code and a sentence saying why.

`/remove-request` answers `202` with
`{"status": "received", "request": n, "d", "token": "eventindex-remove-…", "instructions": "…"}`.
The token is the organizer's proof: placed in the calendar's description or
in one of its events (its title or description), it is found at the next poll
and marks the request verified. A maintainer approves or rejects each request; an approved removal
is carried out as [`indexer-rules.md`](indexer-rules.md) § 10 describes.

The pages of `eventindex.space` post the same requests as forms
(`POST /submit`, `POST /calendar/<local name>/remove`) and answer in HTML.

### Requests signed with your key

Organizers already on nostr act with their own key. Each of these requests
carries `Authorization: Nostr <base64 of a NIP-98 event>`: a kind `27235`
event signed by the organizer's key, with `["u", "<the request's URL>"]`
(the API's address, or the same path on `https://eventindex.space`; for a
request made on the server itself, not through its proxy, also its loopback
address, so the site can be run locally),
`["method", "POST"]` and `["payload", "<hex SHA-256 of the body>"]`, made
within 60 seconds of the request. Each proof is used once. They are limited to
20 an hour per client address, take a JSON object of at most 16 KiB, and the
pages of `eventindex.space` make them through a browser extension (NIP-07).

| Request | Does |
|---|---|
| `POST /calendars/native` with `{"city": "<city slug>"}` (optional) | lists the calendar the key publishes on nostr at once, when its relays hold NIP-52 events from it, or, when it is filed, lists it and sets its city ([`indexer-rules.md`](indexer-rules.md) § 12) |
| `POST /calendars/<local name>/remove-request`, signed with the key the calendar is published with | removes the calendar at the poll service's next tick, with no review |
| `POST /calendars/<local name>/claim` with `{"mode": "link"}`, `{"mode": "own"}` or `{"mode": "delegated", "bunker": "bunker://…"}` | claims a mirrored calendar for the key ([`indexer-rules.md`](indexer-rules.md) § 13): `link` to be named as its organizer while the index keeps mirroring it, `own` to publish it yourself, `delegated` to have the index publish it as you through the remote signer (NIP-46) at that address |
| `POST /calendars/<local name>/claim/<claim>/nip05` with `{"nip05": "<name>@<domain>"}` | verifies the key's claim by NIP-05 at the calendar's own domain |
| `POST /calendars/<local name>/signer` with `{"action": "disconnect"}` or `{"action": "connect", "bunker": "bunker://…"}` | for the calendar's organizer: stops or starts the index publishing it as them, without review |

`/calendars/native` answers `201` with
`{"status": "listed", "d": "nostr:<hex key>", "local_name", "name", "events": n, "message"}`,
or `200` with `{"status": "updated", "d", "local_name", "location"}` for a
calendar listed already. A signed remove request answers `202` with
`{"status": "approved", "request": n, "d", "message"}`; signed with another key,
`403` `not-owner`.

`/claim` answers `202` with
`{"status": "received", "claim": n, "d", "mode", "token": "eventindex-claim-…", "nip05_domains": [...], "instructions": "…"}`.
The token, placed in the calendar's description or in one of its events, is
found at the next poll and verifies the claim; so does NIP-05 at one of
`nip05_domains`, the calendar's own domains (none for a calendar on a
platform's domain). A signer's address is sealed for the poll service as soon
as it arrives; the HTTP service keeps it only sealed. A maintainer approves a
verified claim, and the poll service carries it out at its next tick.

`/nip05` answers `200` with `{"status": "verified", "claim": n, "by": "nip05"}`.
`/signer` answers `202` with `{"status": "received", "request": n, "message"}`.

Errors are `{"error": "<code>", "message": "<text>"}` with an HTTP status:

| Status | Codes |
|---|---|
| 400 | `invalid-url`, `unsupported-feed`, `private-feed-url`, `invalid-parameter`, `invalid-body`, `invalid-message`, `too-long`, `invalid-mode`, `invalid-signer`, `invalid-action`; a link that names no calendar: `meetup-page`, `luma-page`, `google-page`, `nip05` (names no key), `invalid-key` |
| 401 | `unauthorized`, with `reason`: `missing`, `malformed`, `bad-signature`, `wrong-kind`, `expired`, `wrong-url`, `wrong-method`, `wrong-payload`, `used` |
| 403 | `not-yours` (a claim made by another key), `not-owner` (a calendar its organizer does not publish, or another key's; or a remove request signed by a key other than the calendar's) |
| 404 | `not-found` |
| 405 | `method-not-allowed` |
| 409 | `already-listed` (with `d` and `local_name`), `not-indexed` (removed at its organizer's request), `already-claimed`, `already-owner` (with `d` and `local_name`: the key publishes a listed calendar itself, or would, and so may own no other; [`indexer-rules.md`](indexer-rules.md) § 13), `not-a-calendar`, `not-pending`, `not-delegated`, `no-feed` |
| 410 | `removed` |
| 413 | `too-large` (the request body) |
| 422 | the feed could not be used: `private-address`, `too-large`, `not-icalendar`, `empty`, `dns`, `timeout`, `too-many-redirects`, `http-<status>`; a key with nothing to file: `no-relay-answered`, `no-events`; NIP-05: `nip05-invalid`, `nip05-domain` (with `nip05_domains`), `nip05-unreachable`, `nip05-mismatch` |
| 429 | `rate-limited` (with `Retry-After`), `too-many-requests` (a calendar with 10 requests or claims waiting) |
| 503 | `queue-full` (1,000 submissions waiting), `not-ready` (the poll service has not started), `not-available` (the index cannot read relays) |

nostr developers can also add to the index by publishing: a directory entry
(kind `39999`) under their own key, or NIP-52 events that the index reads by
kind once their calendar is filed by its key.

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
- An organizer can claim their calendar, to publish it from their own nostr
  key, or have it removed from the index
  (`https://eventindex.space/calendar/<local name>`).
