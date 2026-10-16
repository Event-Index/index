# The iCalendar profile

Status: draft.

The index keeps one **record** per event: a normalized VCALENDAR that holds the
event's VEVENTs, its calendar's own properties and the VTIMEZONE blocks the
events use. The record is the truth; `.ics`, jCal, JSON-LD and NIP-52 are
projections of it ([`nip52-mapping.md`](nip52-mapping.md), [`api.md`](api.md)).

Standards: RFC 5545 (iCalendar), RFC 7265 (jCal), RFC 7986 (calendar
properties), RFC 9073 (event publishing extensions).

## 1. Parsing

- A feed is parsed with ical.js. A leading byte-order mark is ignored; CRLF and
  bare LF line endings are both accepted, and so are long lines left unfolded.
- A feed with more than one VCALENDAR is read from the first, and the rest are
  logged.
- A feed that does not parse as a whole is parsed part by part: each of the
  calendar's own content lines, and each top-level component on its own. A
  part that fails is left out and logged (`unparseable-event`,
  `unparseable-line`); the rest of the feed is read.
- Text values are unescaped (`\n`, `\,`, `\;`, `\\`).

## 2. Time zones

- A `TZID` the feed defines with a VTIMEZONE is read with that definition.
- A `TZID` the feed uses without a VTIMEZONE is resolved against the IANA time
  zone database bundled with the index (generated from tzdb). Resolution
  accepts canonical names (`Europe/Paris`), links (`US/Pacific` →
  `America/Los_Angeles`, `Asia/Calcutta` → `Asia/Kolkata`) and vendor prefixes
  (`/mozilla.org/20050126_1/America/New_York`), by trying the last three, two
  and one path segments in turn.
- A `TZID` that resolves to nothing (`Eastern Standard Time` with no VTIMEZONE)
  is logged, and its times are read as floating.
- **Floating times** (no `TZID`, no `Z`) are read in the calendar's
  `X-WR-TIMEZONE` when it names an IANA zone, else in UTC, and are flagged.
- The record carries a VTIMEZONE for every `TZID` its events use: the feed's
  own block when there is one, else the bundled one, named exactly as the feed
  wrote the `TZID`.

## 3. Records

- **One record per `UID`.** It holds the master VEVENT (the one without
  `RECURRENCE-ID`) and every override of it (`RECURRENCE-ID`), overrides in
  order of their `RECURRENCE-ID`. A record may hold overrides and no master,
  when the feed serves an occurrence without its series.
- A VEVENT with no `UID` or no `DTSTART` is not recorded, and is logged.
- A time-valued property whose value cannot be read (`DTSTART:TBA`,
  `EXDATE:never`) is dropped and logged (`bad-value`); when it is `DTSTART`,
  the VEVENT is not recorded.
- A VEVENT with no `SUMMARY` is recorded but not projected.
- **Duplicates in one feed.** Two masters with one `UID` (or two overrides with
  one `RECURRENCE-ID`) resolve to the later copy: higher `SEQUENCE`, then later
  `LAST-MODIFIED`, then the one further down the feed. The duplicate is logged.

### 3.1 What a VEVENT keeps

Properties: `UID`, `SUMMARY`, `DTSTART`, `DTEND`, `DURATION`, `DESCRIPTION`,
`STYLED-DESCRIPTION`, `LOCATION`, `GEO`, `URL`, `IMAGE`, `ATTACH`, `CATEGORIES`,
`STATUS`, `SEQUENCE`, `LAST-MODIFIED`, `CREATED`, `RRULE`, `RDATE`, `EXDATE`,
`RECURRENCE-ID`, `ORGANIZER`, `CONFERENCE`, `STRUCTURED-DATA`, and every `X-`
property as given.

Components: `VLOCATION` and `PARTICIPANT` (RFC 9073).

Everything else is dropped, notably `DTSTAMP` (feeds rewrite it on every
fetch), `VALARM` (a subscriber's reminder, not the event's), `ATTENDEE`,
`CONTACT`, `CLASS` and `TRANSP`.

- `DTEND` or `DURATION` is kept as the feed gave it. RFC 5545 forbids both in
  one VEVENT, so the record never carries both; projections compute the end.
- Empty `SUMMARY`, `DESCRIPTION`, `LOCATION` and `URL` values are dropped.
- A feed's own `X-EVENTINDEX-` properties are dropped, from the VEVENT and from
  its subcomponents: only the index writes them.

### 3.2 E-mail addresses

The record keeps an e-mail address only on `ORGANIZER`, where it can serve to
prove control of a calendar, and in the organizer's own prose (`DESCRIPTION`
and the like). Not kept: `ATTENDEE`; an `X-` property or a `URL` whose value
is or holds an address; in `PARTICIPANT` and `VLOCATION`, every property that
holds an address other than `DESCRIPTION`, `STYLED-DESCRIPTION`, `SUMMARY`,
`COMMENT` and `NAME`. No `ORGANIZER` or `ATTENDEE` address reaches any
projection, and no address is ever used as a name (§ 4).

### 3.3 Descriptions with markup

When `DESCRIPTION` holds HTML, or Markdown from a source whose adapter declares
Markdown ([`platform-adapters.md`](platform-adapters.md)), and the event has no
`STYLED-DESCRIPTION`:

- the original moves to `STYLED-DESCRIPTION;FMTTYPE=text/html` or
  `;FMTTYPE=text/markdown` (RFC 9073);
- `DESCRIPTION` becomes its plain text, marked `DERIVED=TRUE`. Links keep their
  targets as `label (url)`; HTML block ends become line breaks; Markdown
  emphasis and backslash escapes are removed.

### 3.4 Calendar properties

The record's VCALENDAR carries `VERSION:2.0`, `PRODID:-//Event Index//index//EN`,
and the feed's `NAME`, `DESCRIPTION`, `URL`, `IMAGE`, `COLOR`,
`REFRESH-INTERVAL`, `SOURCE`, `LAST-MODIFIED`, `X-WR-*` and `X-PUBLISHED-TTL`.

### 3.5 Properties the index adds

On every VEVENT of a record:

| Property | Value |
|---|---|
| `X-EVENTINDEX-CALENDAR` | the address of the calendar's directory entry, `39999:<index key>:<d>` |
| `X-EVENTINDEX-SOURCE` | the entry's source (`luma`, `meetup`, `mobilizon`, `gancio`, `google`, `ics`, `nostr`) |
| `X-EVENTINDEX-ID` | the public event id (§ 6) of the event, or of the occurrence an override stands for |
| `X-EVENTINDEX-VENUE` | `hidden` when the source shows the venue only to registered guests ([`platform-adapters.md`](platform-adapters.md)). Such an event keeps no `LOCATION` or `GEO`, and no projection carries a place for it. |
| `X-EVENTINDEX-CANONICAL` | on a record another calendar's record duplicates: that record's public URL; on an old record of a calendar claimed to publish itself, the URL of the organizer's record that replaces it |
| `X-EVENTINDEX-NOSTR` | the `naddr` of the event's NIP-52 projection, once published; on a record read from its organizer's own key, the `naddr` of their event |
| `X-EVENTINDEX-CLAIMED` | the date (`YYYY-MM-DD`) the calendar was claimed by its organizer, on its records since |

## 4. Calendar metadata

Read from the feed for the directory entry and the calendar key's profile:

- **Name**: `NAME`; else `X-WR-CALNAME`, unless it is a platform default
  (Luma's `Personal`); else the organizer name that occurs most often across
  the feed's events (an `ORGANIZER`'s `CN`, or its value when that value is not
  a URI), ties broken alphabetically, platform-default organizer names
  excluded; else the directory entry's name. A candidate that holds an e-mail
  address is never used (Google names a primary calendar after its owner's
  address).
- **Description**: `DESCRIPTION`, else `X-WR-CALDESC`, unless it is a platform
  default (Luma's `Luma Calendar`).
- **Page**: `URL`, else the page derived from the platform id (§ 5).
- **Image**: `IMAGE`. **Color**: `COLOR`. **Zone**: `X-WR-TIMEZONE`, resolved
  as in § 2.
- **Refresh interval**: `REFRESH-INTERVAL`, else `X-PUBLISHED-TTL`, in seconds.

## 5. Directory identity

A directory entry's `d` is the calendar's stable identity; its feed URL is a
field that may change.

| Source | Feed URL | `d` | Calendar page |
|---|---|---|---|
| Luma calendar | `https://api.luma.com/ics/get?entity=calendar&id=cal-…` (also `api.lu.ma`, `lu.ma`, `luma.com`, `webcal:`) | `luma:cal-…` | `https://luma.com/calendar/cal-…` |
| Luma city page (aggregator) | `…?entity=discover&id=discplace-…` | `luma:discplace-…` | none |
| Meetup group | `https://www.meetup.com/<urlname>/events/ical/` | `meetup:<urlname>`, lowercased | `https://www.meetup.com/<urlname>/` |
| Mobilizon group | `https://<host>/@<group>/feed/ics` | `mobilizon:<host>/@<group>` | `https://<host>/@<group>` |
| Public Google calendar | `https://calendar.google.com/calendar/ical/<id>/public/<file>.ics` | `google:<id>` (percent-decoded) | `https://calendar.google.com/calendar/embed?src=<id>` |
| Native NIP-52 calendar | (none) | `nostr:<pubkey>`: its organizer's key, lowercase hex | its organizer's `website` |
| Anything else | any `http(s)` or `webcal` URL | `ics:` + lowercase hex SHA-256 of the canonical URL | `URL` from the feed |

**Canonical feed URL**: `webcal`/`webcals` becomes `https`; scheme and host
lowercased; a default port and the fragment removed; an empty query removed.
Known platforms are rewritten to the form in the table (Luma to
`api.luma.com` with `entity` then `id`). Other feeds keep their path and query
as given.

A Luma feed of any other `entity` is refused.

### 5.1 Local names

Each directory entry has a local name, used in its calendar page
`https://eventindex.space/calendar/<local name>` and, for a calendar key the
index holds, as its NIP-05 name, served at
`https://eventindex.space/.well-known/nostr.json`. The index names no key it
does not hold (an organizer's own). It is derived from the `d`:

1. An `ics:` entry: `ics-` and the first 16 hex digits of its hash; a
   `nostr:` entry: `nostr-` and the first 16 hex digits of its key.
2. Otherwise: drop a Google `@group.calendar.google.com` or
   `@group.v.calendar.google.com` suffix; remove diacritics; lowercase; replace
   every run of characters other than `a-z` and `0-9` with one `-`; trim `-`.
3. A name longer than 64 characters keeps its first 47 (trailing `-` trimmed),
   then `-` and the first 16 hex digits of the SHA-256 of the `d`.

Examples: `luma:cal-BvuRd9eaZnDGBwy` → `luma-cal-bvurd9eazndgbwy`;
`mobilizon:mobilizon.fr/@lyontechhub` → `mobilizon-mobilizon-fr-lyontechhub`.

A local name, once assigned, belongs to its `d` forever. When a new `d` derives
a name already taken, it gets the first free `-2`, `-3`, … suffix.

## 6. Public event ids

Every record has one public id, and every projected occurrence of a recurring
record has its own:

```
id = base32(first 20 bytes of SHA-256(UTF-8(<calendar d> U+0000 <event d>)))
```

where `<event d>` is the `d` of the event's NIP-52 projection
([`nip52-mapping.md`](nip52-mapping.md) § 2), and `base32` is RFC 4648 lowercase
without padding: 32 characters of `a-z2-7`. The id is stable across polls,
rebuilds and claims (none of them changes the `d`s), unique across calendars,
and safe in a URL. Its URL is
`https://api.eventindex.space/api/1.0/events/byid/<id>`.

**Occurrence key**: an occurrence's original start (its `RECURRENCE-ID`, before
an override moves it) as unix seconds in decimal, or `YYYY-MM-DD` for a date.
A floating `RECURRENCE-ID` is read as in § 2.
