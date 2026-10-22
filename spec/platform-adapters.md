# Platform adapters

Status: draft.

Platforms bend iCalendar in their own ways. Each source has a small adapter
that runs inside normalization ([`icalendar-profile.md`](icalendar-profile.md)),
before the profile's property set applies. This document lists what each
adapter does and what each source's feeds are known to carry.

## Content policy

A calendar has a content policy for the public projections (`.ics`, jCal,
JSON-LD, NIP-52, event items) and for its directory entry. Every calendar is
served as summary and link until its organizer verifies with Event Index;
then it is served in full:

| Source | Until its organizer verifies | Once they have |
|---|---|---|
| `luma` | the summary, no images | the full description, no images |
| `meetup` | the summary, no images | the full description, no images |
| `mobilizon` | the summary, no images | the full description and images |
| `gancio` | the summary, no images | the full description and images |
| `google`, `ics` | the summary, no images | the full description and images |
| `nostr` (events an organizer publishes on nostr themselves) | as published | as published |

An event's text and images are its organizer's, and no platform the index
reads licenses them to third parties, so the index serves a summary and a
link back until the organizer has shown it is theirs. An organizer verifies
by naming their key for the calendar ([`indexer-rules.md`](indexer-rules.md)
§ 13): a link (the calendar stays mirrored, with its owner named), B1
(published from their own key) or B2 (published as them, through their
signer). Luma and Meetup host their events' images under their own terms, so
a verified calendar of theirs still carries none. What an organizer
publishes on nostr themselves is served as they published it.

The loosening is per calendar and undone as it was made: a calendar whose
organizer is no longer verified (its claim undone, or the calendar removed)
is summary and link again, and the operator may keep any calendar so
(`eventindex-admin content <calendar> summary`, undone with `default`). Its
entry is published again at the next tick and its items within ten minutes.

Where the full description is not served, public projections carry the summary
([`nip52-mapping.md`](nip52-mapping.md) § 3) in its place and drop
`STYLED-DESCRIPTION`, `STRUCTURED-DATA`, `X-ALT-DESC` and any property with
`FMTTYPE=text/html`; the directory entry carries no description. Where images
are not served, `IMAGE` and every image `ATTACH` (an `image/*` `FMTTYPE`, or
with none, an image file name) are dropped, and the calendar's directory
entry and items carry no image. Event items carry the summary either way. The
record keeps everything.

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
- **Content.** Public projections carry the summary and the link back, no
  image, as for Luma and Meetup: a group's descriptions and images stay the
  group's. The title and the summary keep the names of performers and artists
  as the group wrote them.
- **A group's feed holds at most its 500 soonest events.** A group with more
  is listed by those 500; its later events appear as the soonest ones pass.
  The instance's API counts them all.
- **Which groups.** Groups come from the instances in the directory at
  `instances.mobilizon.org` (`seeds/mobilizon.json`, filed by
  `eventindex-admin import-mobilizon`): each public group with upcoming
  events, from the instance it lives on (a remote group an instance shows is
  that other instance's), not from instances whose robots.txt disallows
  `/api`, and not from instances or groups held out of it (a single operator's
  ticketed listings, an aggregator of other organizers' events). A group's
  area is the place it states (its locality, its country's code, the geohash of
  its point to 4 characters), or none.
- **Federated copies.** An instance's group may list an event that lives on
  another instance; its `URL` is that event's own address (its ActivityPub
  id), as in its origin group's feed. Two listings with one `URL` and one start
  are one event ([`nip52-mapping.md`](nip52-mapping.md) § 5), so a federated
  copy is a copy of its origin's record and never a second item.

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

## Gancio (`gancio`)

Feed: an instance's own feed of all its events, `https://<host>/feed/ics`
(with a query, `?tags=…` or `?places=…`, it is a filtered view, read as a
generic feed). A Gancio instance is one city's or one community's shared
agenda, so the instance is one calendar, named for the instance: its
`nodeinfo` name, or its host where that name is just `Gancio`. Feeds carry no
calendar name, no `ORGANIZER`, `ATTENDEE` or `CONTACT` (so no event names who
submitted it), no `GEO` and no images; `LOCATION` is the place's name and
address as text. Public projections carry the summary and the link back. Instances come from the project's list at
`gancio.org/instances` (`seeds/gancio.json`), those whose robots.txt allows
the feed, less those held out with their reason. An instance states no
place, so its area is given by hand from its own description, domain or
events: its city, with the city's geohash to 4 characters (a regional agenda
is placed at the main city of its events); `Worldwide` for one of no one
place; or none where it could not be placed.
No adapter rules beyond the profile otherwise.

## Generic iCalendar (`ics`)

No adapter rules beyond the profile. HTML in `DESCRIPTION` is detected and
handled for every source.
