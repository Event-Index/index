# fixtures

Feeds the tests run against. Real feeds were captured on 2026-10-15 from the
public, logged-out iCalendar URLs below and trimmed with
`scripts/sanitize-fixture.ts`. Kept lines are byte-for-byte as captured (line endings included), except:

- every e-mail address on `ORGANIZER` and `ATTENDEE` lines is replaced by
  `redacted@example.invalid`, and `ATTENDEE` lines are capped per event;
- names of individual people are replaced by placeholders ("Host Name",
  "Speaker", "Journaling Studio");
- meeting passcodes are replaced by `REDACTED`;
- every `DESCRIPTION` is trimmed to a summary of at most 280 characters,
  keeping what the platform puts in it that the tests read (Luma's event link,
  address block and hosts line; Meetup's group-name line and Markdown;
  Mobilizon's Markdown escapes; the links of a Google description).

Event content in these files belongs to its organizers; it is here only to
test parsing.

## Real feeds (`feeds/`)

| File | Source | Role | What it exercises |
|---|---|---|---|
| `luma-city-nyc.ics` | Luma Discover feed, New York (`entity=discover&id=discplace-Izx1rQVSh8njYpP`) | aggregator | discovery only; same `UID`s as organizer feeds; longer descriptions than organizer feeds; hidden venue; `CN` "Luma Event"; bare LF line endings |
| `luma-calendar-craftnook.ics` | Luma calendar `cal-BvuRd9eaZnDGBwy` | calendar | event link in `DESCRIPTION`; shared `SEQUENCE`; `STATUS:TENTATIVE`; hidden venue; all-day; co-hosted events; no event text beyond link, address and hosts |
| `luma-calendar-journaling.ics` | Luma calendar `cal-f6iLyfD3TN5qUO2` (names replaced) | calendar | the other side of the co-hosted events |
| `luma-personal-newlab.ics` | Luma calendar `cal-EpqkMBrIPXa045L` | calendar | a platform default calendar (`X-WR-CALNAME:Personal`) |
| `meetup-pythonsd.ics` | `https://www.meetup.com/pythonsd/events/ical/` | calendar | `VTIMEZONE`, `URL`, no `LOCATION` or `GEO`; group name as the first description line; Markdown descriptions; two `UID` shapes |
| `mobilizon-lyontechhub.ics` | `https://mobilizon.fr/@lyontechhub/feed/ics` | calendar | `TZID` without `VTIMEZONE`; unfolded long lines; bare LF line endings; no calendar name; plain-text `ORGANIZER`; empty `LOCATION`; Markdown escapes; image `ATTACH`; in-feed duplicates |
| `google-python-events.ics` | Google Calendar, Python Events Calendar (public) | calendar | all-day events; HTML descriptions; `VALARM` with `ATTACH`; `X-WR-TIMEZONE` |
| `google-kubernetes-sig-cli.ics` | Google Calendar `calendar@kubernetes.io` (public), one series | calendar | unbounded `RRULE`, `EXDATE`, `RECURRENCE-ID`, `VTIMEZONE`, `ATTENDEE`, DST change inside the window |
| `google-us-holidays.ics` | Google Calendar, Holidays in United States | calendar | all-day events |

## Synthetic feeds

`feeds/synthetic/` holds hand-written feeds for cases the real feeds above do
not cover (`PRODID:-//Event Index//fixture//EN`): floating times with and
without `X-WR-TIMEZONE`, `TZID`s without `VTIMEZONE` (IANA, alias, prefixed,
unknown), all-day events, recurrence (moved and cancelled overrides, `EXDATE`,
`RDATE`, unbounded rules, an override without its master), cancellation,
RFC 7986 and RFC 9073 properties (`PARTICIPANT` with a `nostr:` address,
`VLOCATION`, `STYLED-DESCRIPTION`), malformed events, and two calendars that
list the same event under different `UID`s.

`feeds/sequences/` holds successive polls of one calendar, which tests combine
into flapping, vanished and quarantine sequences.

## Pages

`pages/luma-city-nyc.html` is the New York Luma Discover page reduced to the
calendar fields discovery reads (`api_id`, `name`, `slug`, `is_personal`,
`access_level`) inside its original `__NEXT_DATA__` structure.
