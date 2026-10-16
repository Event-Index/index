# The NIP-52 mapping

Status: draft. The nostr wire format (the directory and events list headers,
the projection, calendar keys, removal and claims) is specified in the Event
Index protocol draft; where this document and the draft differ, the draft
governs. This document fixes what the draft leaves to the index.

Reference values used below: index relay `wss://relay.eventindex.space`, API
`https://api.eventindex.space/api/1.0`, domain `eventindex.space`, client name
`eventindex`.

## 1. Which events, which kind

- Only records of `calendar` entries are projected; an `aggregator` entry's
  events never are.
- Every occurrence that overlaps the **window** is projected: from 30 days
  before the poll to 365 days after it. An occurrence lasts from its start to
  its end; with no end, an all-day occurrence lasts its day and a timed one is
  an instant.
- A recurring record (`RRULE` or `RDATE`) is expanded inside the window. Its
  recurrence set is `DTSTART` (always the first instance, and counted toward a
  rule's `COUNT` even when it does not match the rule), the instances of each
  `RRULE` (ical.js's rule iterator), and each `RDATE` (a period gives its
  instance its own end), minus each `EXDATE`.
- Instances, `EXDATE`s and overrides are matched by **occurrence key**
  ([`icalendar-profile.md`](icalendar-profile.md) § 6): the same instant (or
  date), whatever zone each value is written in, and however often it is
  repeated. A date `EXDATE` also removes a timed instance on that local date.
- An override replaces the instance with its key; an override with
  `RANGE=THISANDFUTURE` shifts every later instance by its own move and gives
  them its properties. An override of a single event with the event's own
  start replaces it. An override that no instance reaches (its master is
  absent, or does not produce its key) is an occurrence of its own.
- One address carries one occurrence: when two would share a `d`, the earlier
  is kept.
- A record that cannot be expanded is logged and projects nothing; the rest of
  the calendar is projected.
- A record whose `DTSTART` is a date becomes a kind `31922`; every other record
  a kind `31923`. The calendar's key signs it.
- At most 10,000 occurrences per calendar key, soonest first; the rest are
  logged and not projected.

## 2. Tags from the record

| iCalendar | Tag | Rule |
|---|---|---|
| `UID` | `d` | Lowercase hex SHA-256 of the UTF-8 `UID`; for an occurrence of a recurring record, of `UID` `:` occurrence key ([`icalendar-profile.md`](icalendar-profile.md) § 6). |
| `SUMMARY` | `title` | Required: an occurrence with no `SUMMARY` is not projected. `Cancelled: ` is prefixed when the event is cancelled (§ 4). |
| `DESCRIPTION` | `summary`, `content` | The same text in both: the summary (§ 3). No `summary` tag and empty content when it is empty. |
| `IMAGE`, else an image `ATTACH` | `image` | An `http(s)` `IMAGE`; else the first `http(s)` `ATTACH` whose `FMTTYPE` is `image/*` (or, with no `FMTTYPE`, whose URL ends in an image extension). Only where the source's content policy allows images ([`platform-adapters.md`](platform-adapters.md)). |
| `DTSTART` | `start` | 31923: unix seconds. 31922: `YYYY-MM-DD`. Floating times are read in `X-WR-TIMEZONE`, else UTC. |
| `DTEND`, or `DTSTART` + `DURATION` | `end` | Exclusive. Omitted when the record has no end, or the end is not after the start. |
| zone of `DTSTART` | `start_tzid` | 31923 only. The IANA name of the `TZID`; for a UTC or floating time, the calendar's `X-WR-TIMEZONE` when it names an IANA zone. |
| zone of the end | `end_tzid` | 31923 only, when it differs from `start_tzid`. |
| start and end | `D` | 31923 only: `floor(start / 86400)` through `floor((end − 1) / 86400)`, one tag per day, at most 400; only the first without an end. |
| `LOCATION`, `VLOCATION` `NAME` | `location` | As written; one tag per distinct value, in that order. None when the venue is hidden (`X-EVENTINDEX-VENUE:hidden`). |
| `GEO` | `g` | Geohash of precision 9; none when the venue is hidden. Free-text locations are never geocoded. |
| `PARTICIPANT` with `CALENDAR-ADDRESS:nostr:npub1…` or `nostr:nprofile1…` | `p` | `["p", <hex pubkey>, <relay from the nprofile, else "">, <PARTICIPANT-TYPE lowercased, else "participant">]`. |
| `CATEGORIES` | `t` | Every value lowercased and trimmed, each once, in order. |
| `URL` | `r` | The event's page; when the record has none, the calendar's page. |
| `ORGANIZER`, `ATTENDEE` | — | Never projected. |

Tags the index adds, in this order after the tags above:

```
["p", "<calendar key>", "wss://relay.eventindex.space", "host"]
["p", "<co-host calendar key>", "wss://relay.eventindex.space", "host"]   one per co-host (§ 5)
["t", …]                                                                  from CATEGORIES
["r", "<the event's page>"]                                               when there is one
["r", "https://api.eventindex.space/api/1.0/events/byid/<public id>.ics"]
["z", "39998:<index key>:events"]
["alt", "<calendar name>: <title>, <start date>"]
["client", "eventindex"]
```

The tag order is fixed: `d`, `title`, `summary`, `image`, `start`, `end`,
`start_tzid`, `end_tzid`, `D`…, `location`…, `g`, `p` (host, co-hosts,
participants), `t`…, `r`…, `z`, `alt`, `client`. `alt`'s start date is
`YYYY-MM-DD` in `start_tzid`'s zone, UTC when there is none. No projection
carries an `expiration` tag.

## 3. The summary

The summary is cut from the record's plain-text `DESCRIPTION` (after the
source adapter's own trimming, [`platform-adapters.md`](platform-adapters.md)):

1. Line endings become `\n`; runs of spaces and tabs become one space; each
   line is trimmed; three or more line breaks become two; the text is trimmed.
2. If it is at most 280 user-perceived characters (Unicode extended grapheme
   clusters), it is the summary.
3. Otherwise the first 279 characters are kept, cut back to the last
   whitespace if one lies within the last 40 of them, trimmed, and `…` is
   appended.

## 4. Versions, cancellation, withdrawal

- **Republish on change.** The projection hash is the SHA-256 of the JSON array
  `[kind, tags, content]`. A projection is published when its hash differs from
  the last one published at its address (or nothing was), never because
  `SEQUENCE`, `LAST-MODIFIED` or `DTSTAMP` moved.
- **`created_at`** is the poll time; a bulk publish spreads it backwards so no
  second holds more than 1,000 events. A new version is always later than the
  last version at its address.
- **Cancelled.** An event (or an override) with `STATUS:CANCELLED` is projected
  at the same address with its title prefixed `Cancelled: `.
- **Gone from the feed.** [`indexer-rules.md`](indexer-rules.md) § 6 decides
  when an event is withdrawn. A withdrawn upcoming event with RSVPs is
  republished as cancelled; one without is deleted with a kind `5` carrying an
  `e` for every version id published at the address, the `a` coordinate, and
  `["k", "<kind>"]`.
- **New address.** An event that becomes recurring, stops recurring, or moves
  between 31923 and 31922 is withdrawn at its old address at once.

## 5. Co-hosts

When several calendar entries list one event, it is projected once. Only
occurrences a calendar can project (with a title, within its cap) take part,
so an event never yields to a copy that will not be published.

- **Same event**: the same `UID` and the same start, or the same event `URL`
  (fragment and trailing `/` ignored) and the same start.
- **Signer**: the calendar whose name equals the event's organizer name (`CN`,
  compared case-insensitively after Unicode normalization and whitespace
  collapsing) in any of the listings; if several, the one with the lowest `d`
  (by code point); if none, the calendar with the lowest `d`.
- The signer's projection adds a `host` `p` for every other calendar, and
  every other calendar's record carries `X-EVENTINDEX-CANONICAL` with the
  signer's record URL.
- Every co-host's kind `31924` lists the event too.
- A calendar whose event now yields to another signer deletes its own copy at
  once (§ 4), RSVPs or not: the event lives on at the signer's address.

## 6. The calendar key's events

**Kind 0.** `content` is a JSON object with, in this order: `name` (the
calendar's name, [`icalendar-profile.md`](icalendar-profile.md) § 4), `about`,
`picture` (the calendar's image, where the source's policy allows images),
`website` (the calendar's page), `nip05` (`<local name>@eventindex.space`).
`about` by state:

| State | `about` |
|---|---|
| Mirrored, from a platform | `Events of <name>, mirrored from <platform> by Event Index, which is not affiliated with <owner>. Organizer? You can have this calendar removed: https://eventindex.space/calendar/<local name>.` |
| Mirrored, from any other feed | `Events of <name>, mirrored from its calendar feed by Event Index. Organizer? You can have this calendar removed: https://eventindex.space/calendar/<local name>.` |
| Removed | `No longer mirrored by Event Index at its organizer's request.` |

`<platform>` is the platform as its owner styles it, and `<owner>` who owns
it: `Luma` / `Luma`, `Meetup®` / `Meetup`, `Mobilizon` / `Mobilizon`, `Gancio` /
`Gancio`, `Google Calendar` / `Google`. The sentence offers removal only;
claiming a calendar is not offered by this index.

A calendar key's `picture` is only ever its calendar's own image; one with no
image has no `picture`. The Event Index mark is the index key's alone: its
kind 0 is `name` `Event Index`, `about`, `picture`
`https://eventindex.space/brand/mark-tile-512.png` (the mark on its tile,
[`../brand/`](../brand/README.md)), `website` `https://eventindex.space`,
`nip05` `_@eventindex.space`. Its kind 10002 follows the rule below, and its
kind 3 lists every calendar key the index holds
([`indexer-rules.md`](indexer-rules.md) § 11).

**Kind 10002.** `["r", "wss://relay.eventindex.space"]` with no marker (RSVPs
and comments sent to the host's inbox reach the index), then
`["r", <relay>, "write"]` for each general relay the index publishes to
(`wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.damus.io`), none
while it publishes only to its own relay. It never names a relay that does
not hold the calendar's events. The index key's kind 10002 follows the same
rule.

**Kind 31924.** `d` = `calendar`, `title` = the calendar's name, `content` =
its description (or empty), and `["a", <address>, "wss://relay.eventindex.space"]`
for every event the calendar signs or co-hosts that starts no earlier than 30
days before the poll, soonest first, at most 300 (which keeps the event under
65,536 bytes). Republished when it changes, like any projection.

Calendar keys are random, one per `calendar` entry the index adopts, never
derived and never created for an aggregator or a native NIP-52 calendar.
