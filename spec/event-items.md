# Event items

How the index lists events on nostr: one item of the Events list per
upcoming real-world event of a mirrored calendar, a kind 39999 signed by the
index key. The index names each event's organizer and never publishes as
them. Events their organizers publish on nostr themselves are read as they
are ([`indexer-rules.md`](indexer-rules.md) § 14) and get no item.

Items are published while the operator turns them on (`EVENT_ITEMS`); the
Events list's header is a maintainer's, `39998:<maintainer's key>:events`.

Status: draft.

## 1. Which events

- Every occurrence in the events table (the projection window,
  [`nip52-mapping.md`](nip52-mapping.md) § 1) of a `calendar` entry that the
  index mirrors from a feed and that is listed: not a native or aggregator
  entry, not one its organizer claimed to publish themselves or to have
  published as them ([`indexer-rules.md`](indexer-rules.md) § 13), not
  removed.
- Only events that have not ended (their end, or their start when they have
  none, is not past).
- **One item per real-world event.** An occurrence that is a copy of another
  (a co-host's copy of the same event, [`nip52-mapping.md`](nip52-mapping.md)
  § 5, or a feed's copy of an organizer's own NIP-52 event,
  [`indexer-rules.md`](indexer-rules.md) § 14) has no item; its original is
  the one listed or read.
- **Aggregators' copies.** An aggregator (an entry with role `aggregator`,
  such as one that reposts other organizers' events) may publish its own
  NIP-52 copy of an event the index has an item for. Each NIP-52 event the
  index matches to the item's event as such a copy
  ([`indexer-rules.md`](indexer-rules.md) § 15) is named on the item by a tag
  `["a", "<kind>:<pubkey>:<d>", "<relay>", "copy"]`, with the relay the index
  read it from (an empty string when not known): the newest 20 copies, by
  their `created_at`. A copy matched or no longer matched changes the item,
  which is published again as any change is. A client that shows both NIP-52
  events and items may hide any event an item names in a `copy` tag. Only
  aggregators' copies are named: where the original is the organizer's own
  NIP-52 event, the feed's event has no item (above). The `a` tag is a
  single-letter tag, so the Events header declares no field for it.
- An event that runs longer than 92 days is a listing, not an event: it has
  no item, and stays a record.

## 2. The item

Tags in this order; a tag with no value is left out. `content` is empty.

| Tag | Value |
|---|---|
| `d` | the occurrence's public id ([`icalendar-profile.md`](icalendar-profile.md) § 6) |
| `z` | the Events list's header |
| `title` | `SUMMARY`; prefixed `Cancelled: ` when the event is cancelled |
| `start`, `end` | unix seconds; for an all-day event `YYYY-MM-DD`, the end the day after the last day (exclusive) |
| `when` | when it happens, written out in its local time: `Wed 28 Oct 2026, 5:30 PM-8:00 PM EDT`; across days `Wed 16 Sep, 7:00 AM to Thu 17 Sep 2026, 6:00 PM EDT`; with no end `Wed 28 Oct 2026, 5:30 PM EDT`; all-day `Wed 28 Oct 2026, all day` or `Mon 19 Oct to Sat 24 Oct 2026`. The zone's abbreviation where one is in use, else its offset (`GMT-3`) |
| `start_tzid` | not for an all-day event: the zone the event happens in: the feed's `TZID`; for a time in UTC, the zone at the venue the record names (`X-EVENTINDEX-TZID`, [`icalendar-profile.md`](icalendar-profile.md) § 3.5), else the feed's own zone; else the zone at the venue's `g`; else that of the calendar's city; else `UTC`. The zone at a point comes from the time-zone boundaries (below); a point at sea names none |
| `organizer` | the calendar's name |
| `calendar` | the calendar's entry, `39999:<index key>:<calendar d>` |
| `source` | `luma`, `meetup`, `google`, `mobilizon` or `gancio`; for any other calendar, its feed's host |
| `location`, `g` | the venue and its geohash, as the record gives them; none for a hidden venue ([`platform-adapters.md`](platform-adapters.md)). A Meetup event's `location` may come from its page, as text with no `g` (there, Event pages) |
| `summary` | the event's summary, under its source's content policy, at most 280 characters ([`nip52-mapping.md`](nip52-mapping.md) § 3) |
| `status` | `cancelled` when the record is `STATUS:CANCELLED` |
| `p` | the organizer's own key (hex), once they verified it (§ 5); none otherwise |
| `luma-slug` | for a Luma event, its address on Luma (`https://luma.com/<slug>`) |
| `meetup-group`, `meetup-event` | for a Meetup event, the group and the event's number in its address |
| `index-id` | the public id again, for the Event Index link |
| `url` | for any other source, the event's own page |
| `image` | the event's image, only where its source's content policy allows images |
| `t` | the calendar's city's slug, or `global` for a calendar of no one city (its area `Worldwide` or `Online`), then the source |
| `i`, `k` | the event's page as a NIP-73 identifier, kind `web` |
| `expiration` | NIP-40: the event's end (all-day: its exclusive end date at 00:00 UTC; with no end, its start) plus 30 days |
| `alt` | `<calendar name>: <title>` |
| `a` … `copy` | one per aggregator's NIP-52 copy matched to the event (§ 1, Aggregators' copies): `["a", "<kind>:<pubkey>:<d>", "<relay the copy was read from, or empty>", "copy"]`, newest first, at most 20 |

The time-zone boundaries are those of timezone-boundary-builder, read through
geo-tz. A zone named from them contains information from timezone-boundary-builder,
which is made available under the Open Database License (ODbL).

## 3. Publishing

- An item is published when it is new or its tags change (a hash per `d`),
  with `created_at` after its last version's and spread over the seconds
  before now, at most 100 a second. At most 2,000 are signed in one tick; the
  rest follow at the next ticks. All items are looked at again every
  10 minutes, and at once after a removal or a claim.
- The operator may cap how many items are live at once (`EVENT_ITEMS_MAX`):
  live items are kept up to date and withdrawn as usual, and a new one waits
  for room.
- The operator may list the calendars whose events are items
  (`EVENT_ITEMS_CALENDARS`, a file such as `seeds/item-calendars.json`): only
  their events are items, and a calendar taken off the list has its items
  withdrawn at once. The directory lists every calendar either way.
- **Withdrawal.** An item whose event has left its calendar for a day (a feed
  may drop an event for a while), or at once when its calendar is no longer
  listed or mirrored, is withdrawn with a kind 5 naming every version's `e`,
  then its `a` (`39999:<index key>:<d>`) and its `k` (`39999`). An item whose
  event has ended is left to expire.
- **Expiry.** Once an item passes its `expiration`, the index marks it
  expired and deletes it from the list relays itself, not counting on them to
  honor NIP-40: a kind 5 naming, for several expired items, every version's
  `e` and each item's `a`, with one `k` (`39999`), in at most 200 tags, an
  item's tags never split between two deletions (one with more versions than
  fit names its newest 198). Deletions are signed once, with `created_at`
  spread one a second before now, and kept in `index.db`; each is sent to the
  list relays alone, at their pace (the index's relay and the search relays
  drop an expired event themselves), and sent again after a restart, or after
  a list relay was paused, until the relays' queues have emptied with none
  paused. An expired item is not published again: an edit to its event, now
  past, changes nothing. An event moved to end in the future again is upcoming
  once more, and its item is published anew, later than its deletion.
- **Where.** The index's relay; and, while the directory is published outside
  ([`directory.md`](directory.md)), the search relays and the list relays,
  each at its pace. Never the general or profile relays. Withdrawals go the
  same way; deletions of expired items to the list relays only.

## 4. Records

A single event's record names its item: `X-EVENTINDEX-NOSTR` is the item's
`naddr` (kind 39999, the index key, its `d`, the index relay), from the
calendar's first full read after the item is published.

## 5. Organizers

An organizer who proves a calendar and their key may have the index name
them as its organizer ([`indexer-rules.md`](indexer-rules.md) § 13, `link`):
their key is the `p` of the calendar's entry and of every one of its items,
and the index goes on listing its events. Or they may publish the calendar
themselves (`own`) or have it published as them (`delegated`); its events are
then theirs, and its items are withdrawn.
