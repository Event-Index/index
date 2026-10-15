# API reference

Status: draft; not yet served.

Base URL: `https://api.eventindex.space/api/1.0`. The version is part of every
path. Read endpoints need no key and send `Access-Control-Allow-Origin: *`.

## Identifiers

- **Calendar**: its directory entry's `d` ([`icalendar-profile.md`](icalendar-profile.md) § 5),
  or in a path, its local name (§ 5.1 there), which is URL-safe. The calendar
  key is its `guid`.
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
or `ATTENDEE`. An occurrence of a recurring event is served as that one
instance (its `RECURRENCE-ID` set, its rule removed).

## Read

### Calendars

| Request | Returns |
|---|---|
| `GET /calendars/byfeedurl?url=<feed URL>` | the entry whose canonical feed URL matches |
| `GET /calendars/byslug/<local name>` | one entry |
| `GET /calendars/byguid/<npub>` | the entry of a calendar key |
| `GET /search/calendars/byterm?q=&near=<geohash>&tag=` | matching entries |

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
    "location": "San Diego, CA",
    "g": "9mud",
    "t": ["python"]
  },
  "eventindex": {
    "address": "39999:<index key>:meetup:pythonsd",
    "nostr": { "npub": "npub1…", "nip05": "meetup-pythonsd@eventindex.space", "calendar": "naddr1…" },
    "last_indexed": 1792087200,
    "event_count": 4,
    "stale": false,
    "claimed": false,
    "removed": false
  }
}
```

### Events

| Request | Returns |
|---|---|
| `GET /events/byid/<id>[.ics\|.json]` | one record or occurrence |
| `GET /events/bycalendar/<local name>?from=&to=` | a calendar's occurrences between two unix times (default: the projection window) |
| `GET /search/events/byterm?q=&from=&to=&near=<geohash>&radius=<km>&tag=` | matching occurrences |

A list of events is `{"events": [...], "count": n}` where each item is the
format of the request (jCal by default, JSON-LD with `.json`). Each jCal item
is accompanied by:

```json
"eventindex": {
  "id": "<public id>",
  "nostr": "naddr1…",
  "calendar": "<calendar d>",
  "canonical": "<public id of the signing record, when this one is a co-host's copy>",
  "cohosts": ["<calendar d>"],
  "source": "luma"
}
```

### Feeds

| Request | Returns |
|---|---|
| `GET /ics/calendar/<local name>.ics` | a calendar's events as one feed, in the window |
| `GET /ics/city/<city>.ics` | events of the directory's calendars in a city, built from those calendars (never a copy of an aggregator's feed) |

### Directory and service

| Request | Returns |
|---|---|
| `GET /dump/index.db` | a nightly SQLite file: directory entries, calendar metadata and poll statistics. No event content. CC0 1.0. |
| `GET /stats` | counts of calendars, events and polls |
| `GET /.well-known/nostr.json?name=<local name>` (on `eventindex.space`) | NIP-05 names of calendar keys and of the index key (`_`) |

## Write

Write endpoints take an app key, sent as `Authorization: Bearer <key>`, never
in the URL. Keys are issued per registered app.

| Request | Does |
|---|---|
| `POST /feeds/add` with `{"url": "<feed URL>"}` | validates the feed ([`indexer-rules.md`](indexer-rules.md) § 4), files a directory entry under the index key, creates the calendar key, runs the first poll; returns the entry's address and the calendar key's npub |
| `POST /calendars/<local name>/remove-request` | starts removal of a calendar at its organizer's request |

Errors are `{"error": "<code>", "message": "<text>"}` with an HTTP status.
Validation codes: `invalid-url`, `unsupported-feed`, `private-feed-url`,
`private-address`, `too-large`, `not-icalendar`, `empty`, `dns`, `timeout`,
`too-many-redirects`, `http-<status>`.

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
