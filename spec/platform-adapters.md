# Platform adapters

Status: draft.

Platforms bend iCalendar in their own ways. Each source has a small adapter
that runs inside normalization ([`icalendar-profile.md`](icalendar-profile.md)),
before the profile's property set applies. This document lists what each
adapter does and what each source's feeds are known to carry.

## Content policy

Each source has a content policy for the public projections (`.ics`, jCal,
JSON-LD, NIP-52):

| Source | Full description | Images |
|---|---|---|
| `luma` | no: the summary only | no |
| `meetup` | no: the summary only | no |
| `mobilizon`, `gancio`, `google`, `ics` | yes | yes |
| `nostr` (events an organizer publishes on nostr themselves) | yes | yes |

Where the full description is not served, public projections carry the summary
([`nip52-mapping.md`](nip52-mapping.md) § 3) in its place and drop
`STYLED-DESCRIPTION`, `STRUCTURED-DATA`, `X-ALT-DESC` and any property with
`FMTTYPE=text/html`. Where images are not served, `IMAGE` and every image
`ATTACH` (an `image/*` `FMTTYPE`, or with none, an image file name) are
dropped, and the calendar's directory entry carries no image. The record keeps
everything.

A calendar's policy is its source's. A calendar claimed by its organizer keeps
its platform's policy for what comes from its feed; what it publishes from
its own key is `nostr`.

## Luma (`luma`)

Feeds: `https://api.luma.com/ics/get?entity=calendar&id=cal-…` (an organizer's
calendar) and `…?entity=discover&id=discplace-…` (a city page, an aggregator).
Bare LF line endings.

- **Event link.** The first line of `DESCRIPTION` reads
  `Get up-to-date information at: <url>`. The URL becomes the event's `URL`
  (unless it has one), and the line and the blank line after it are removed.
- **`SEQUENCE`** is one large number shared by every event of a feed. It is
  dropped.
- **`STATUS`** is `TENTATIVE` on every event. Only `STATUS:CANCELLED` is kept.
- **Hidden venue.** An event whose venue is shown only to registered guests has
  `LOCATION` set to its own page (`https://luma.com/event/evt-…`) and the address
  block `Address:` / `Check event page for more details.`, while `GEO` still
  carries the venue's coordinates. The index keeps no place for such an event:
  its `LOCATION` and `GEO` are dropped from the record, the event is marked
  `X-EVENTINDEX-VENUE:hidden`, and no projection carries a `location`, `g`,
  `GEO` or coordinates for it ([`nip52-mapping.md`](nip52-mapping.md) § 2). A
  search for events near a place matches it by its calendar's area (the
  directory entry's `location` and `g`).
- **Platform defaults.** A calendar named `Personal` is an account's default
  calendar; its name comes from its events' organizer. The calendar description
  `Luma Calendar` and the organizer name `Luma Event` are platform text, not the
  organizer's.
- **`ORGANIZER`** carries the event's host as `CN` (often a person, not the
  calendar) and the generic address `calendar-invite@lu.ma`, never the host's
  own.
- **Summary.** The summary is cut from the description after removing its
  leading `Address:` block and its closing `Hosted by …` line.
- **Content.** An organizer calendar's events carry no text beyond the link,
  the address and the hosts. A city feed carries a longer description, cut
  short by Luma.
- **Same events in several feeds.** An event carries the same `UID` in a city
  feed and in each organizer calendar that lists it.
- **Discovery.** A city page's `__NEXT_DATA__` names each event's calendar
  (`api_id`, `name`, `slug`, `is_personal`); see
  [`indexer-rules.md`](indexer-rules.md) § 2.

## Meetup (`meetup`)

Feed: `https://www.meetup.com/<urlname>/events/ical/`, readable logged out.

- Carries `URL`, a `VTIMEZONE`, `SEQUENCE`, `LAST-MODIFIED` and `CREATED`; no
  `GEO` and no `LOCATION`. The place comes from the event's page, when the
  index reads pages (below), or else only from the description text.
- **Group name.** Each `DESCRIPTION` begins with the group's name on a line of
  its own; that line is removed when it equals the calendar's name.
- **Markdown.** Descriptions are Markdown and move to `STYLED-DESCRIPTION`
  ([`icalendar-profile.md`](icalendar-profile.md) § 3.3).
- **Two `UID` shapes**: `event_<number>@meetup.com` for announced events and
  `event_<letters>@meetup.com` for future occurrences of a series not yet
  announced.
- A feed URL with a `sig` parameter, or under `/events/ical/<member id>/…`, is a
  member's own feed and is refused.

### Event pages

With pages read (`MEETUP_PAGES`), an upcoming event of a mirrored Meetup
calendar whose `URL` is its page (`https://www.meetup.com/<urlname>/events/<id>/`)
has that page read once when the event is first seen, and again only when
the feed's `LAST-MODIFIED` or `SEQUENCE` for it changes. The index reads the
page's schema.org `Event` JSON-LD (`<script type="application/ld+json">`) and
nothing else on it: not the page's app data (`__NEXT_DATA__`, `/_next/data/`),
which carries the venue's coordinates.

- **Venue.** A `Place` in `location` becomes `LOCATION` text: its `name`, its
  address's `streetAddress` and its `addressLocality`, each left out when the
  text so far already holds it, at most 300 characters. A name that says the
  venue is not shown or not set ("Location visible to members", "Needs a
  location", "TBA") is not a venue. A page that shows no venue to a
  logged-out reader gives none: the event keeps no place.
- **Online.** `eventAttendanceMode` `OnlineEventAttendanceMode`, or
  `eventStatus` `EventMovedOnline`, makes `LOCATION` `Online`. A mixed event
  keeps its venue.
- **Cancelled.** `eventStatus` `EventCancelled` sets `STATUS:CANCELLED`.
- **Never** coordinates, a geocoded point, images or the description: the
  record keeps no `GEO` from a page, and items carry `location` text with no
  `g`.
- The page's values never replace the feed's: a `LOCATION` the feed gives is
  kept, and a page that no longer says cancelled gives the feed's `STATUS`
  back. The record marks what came from the page with `X-EVENTINDEX-ENRICHED`
  ([`icalendar-profile.md`](icalendar-profile.md) § 3.5). Until a changed event's
  page is read again, its record keeps what the page said last.

Reading is polite: requests carry the index's User-Agent, which names its
site (`EventIndex/0.1 (+https://eventindex.space)`); at most one request goes to meetup.com every 5 seconds, feeds
included; a page is asked for with the validators of its last read
(`If-None-Match`, `If-Modified-Since`). The site's robots.txt is read once a
day, and a path it disallows for `EventIndex` (or for `*`, when no group
names the index) is never requested; while robots.txt cannot be read (a 5xx
or a network error), no page is, and a site without one (any other 4xx)
allows every page. A 403 or 429 pauses reading for 10 minutes, doubled with
each one in a row, up to a day, or for as long as `Retry-After` asks; five in
a row stop it until the operator resumes it. A page that is gone (404, 410)
gives nothing, and one that cannot be read is tried again an hour later, up
to five times for the same version of the event.

## Mobilizon (`mobilizon`)

Feed: `https://<host>/@<group>/feed/ics`.

- `TZID` without `VTIMEZONE`, resolved from the bundled zones.
- Long lines left unfolded; bare LF line endings.
- **`ORGANIZER`** is the group's name, not a calendar address; it is read as the
  organizer name.
- No calendar name; the name comes from the organizer.
- **`LOCATION`** is empty on online events (dropped) and repeats the city and
  country code on others (kept as written).
- **Markdown** descriptions with backslash escapes (`\-`, `\~`), which move to
  `STYLED-DESCRIPTION`; paragraph breaks are already lost in the feed.
- The banner image is an `ATTACH;FMTTYPE=image/…`.
- A group that relays other communities' events may list one event twice
  under different `UID`s.
- `/events/going/<token>/…` addresses are a member's own feed and are refused.

## Google Calendar (`google`)

Feed: `https://calendar.google.com/calendar/ical/<id>/public/basic.ics`.

- **HTML** descriptions (often marked `X-MOZ-GOOGLE-HTML-DESCRIPTION:true`),
  which move to `STYLED-DESCRIPTION`.
- **Event link.** When an event has no `URL` and its HTML description holds
  exactly one `http(s)` link, that link becomes the `URL`.
- `VALARM` blocks left by the organizer's clients, some with `ATTACH`; dropped
  with the alarm.
- `X-WR-TIMEZONE` names the calendar's zone.
- Recurring series with `RRULE`, `EXDATE` and `RECURRENCE-ID` overrides, often
  with many `ATTENDEE`s (not kept).
- `…/private-<token>/basic.ics` addresses are private and are refused.

## Generic iCalendar (`ics`, `gancio`)

No adapter rules beyond the profile. HTML in `DESCRIPTION` is detected and
handled for every source.
