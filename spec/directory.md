# The directory on nostr

Status: draft.

The directory is a DList: a list header (kind 39998) and one entry (kind
39999) per calendar or aggregator. The header is signed by a maintainer of the
directory and names the list's fields, how an item is shown, and the URL
templates its links use. The Event Index key is the list's curator: it signs
the entries, and no header. The header's coordinate is a setting of the index
(`EVENTINDEX_DIRECTORY_HEADER`, `39998:<maintainer key>:event-calendars`);
every entry's `z` names it.

## An entry

`d` is the directory entry's identity ([`icalendar-profile.md`](icalendar-profile.md) § 5).
The tags come in this order, and a tag with no value is left out:

| Tag | Value |
|---|---|
| `d` | the entry's `d`, e.g. `luma:cal-BvuRd9eaZnDGBwy` |
| `z` | the header's coordinate |
| `name` | the calendar's name ([`icalendar-profile.md`](icalendar-profile.md) § 4) |
| `role` | `calendar`; or `aggregator`, for a feed that only leads to calendars, or a nostr key that publishes other organizers' events under its own |
| `p` | the key the calendar's events are signed with now (hex): the calendar key, or its organizer's own (below); for an aggregator on nostr, its key; none for a feed aggregator |
| `p` | after a claim, the calendar key the index held, while events it signed are still to come (below) |
| `index-name` | the calendar's local name: its page is `eventindex.space/calendar/<name>`, and, while the index holds its key, its NIP-05 name `<name>@eventindex.space` |
| `feed` | the feed URL the calendar is read from; none when its events are read from nostr |
| `source` | `luma`, `meetup`, `mobilizon`, `gancio`, `google`, `ics`, or `nostr` when its events are read from its organizer's own key |
| `location` | the calendar's area, `<city>, <country code>` |
| `g` | the area's geohash |
| `luma-id` | for a Luma calendar: its id, `cal-…` |
| `meetup-group` | for a Meetup group: the group's name in its address |
| `calendar` | a kind 31924 of the organizer's that the calendar stands for (below) |
| `t` | the city's slug (`san-diego`), then the source; repeats |
| `description` | the calendar's description, where the source's content policy serves descriptions ([`platform-adapters.md`](platform-adapters.md)) |
| `image` | the calendar's image, where the source's content policy serves images |
| `removed` | for a calendar removed at its organizer's request: `organizer request` ([`indexer-rules.md`](indexer-rules.md) § 10) |

`content` is empty. Entries are republished when they change, with
`created_at` one second apart.

## Calendars published from their organizers' own keys

An entry's events are published in one of three ways:

| | Who signs its events | `p` | `source`, `feed` | `calendar` |
|---|---|---|---|---|
| **Mirrored** | the calendar key the index holds ([`nip52-mapping.md`](nip52-mapping.md) § 6) | the calendar key | the platform, the feed | none |
| **By its organizer** | the organizer, from their own key; the index reads their events ([`indexer-rules.md`](indexer-rules.md) § 12) | the organizer's key | `nostr`, none | their newest kind 31924, if any |
| **As its organizer** | the index, with the organizer's key, through a remote signer they connected ([`indexer-rules.md`](indexer-rules.md) § 13) | the organizer's key | the platform, the feed | `31924:<organizer>:<the entry's d>` |

- A **native calendar** is published by its organizer from the start. Its
  `d` is `nostr:<organizer's hex key>` ([`icalendar-profile.md`](icalendar-profile.md) § 5),
  it has no feed, and the index makes no calendar key for it.
- A **claimed** calendar was mirrored until its organizer claimed it
  ([`indexer-rules.md`](indexer-rules.md) § 13). It keeps its `d`, its
  `index-name` and its platform id (`luma-id`, `meetup-group`). Until the
  last event its old calendar key signed has started, the entry names that
  key in a second `p`, after the organizer's, so readers who find events
  through the directory still find those; then it is republished without it.
  The first `p` is always the calendar's current key.
- A **publisher listed from what it posts**: the index reads every public
  NIP-52 event ([`indexer-rules.md`](indexer-rules.md) § 14) and lists every
  key it keeps events of, filed by the index key as curator, with no review:
  a native calendar like any other, named from the publisher's profile. A key
  that publishes other organizers' events under its own (listed in
  `seeds/nostr-aggregators.json`) is listed with the role `aggregator` and its
  `p`. Proof of the key is needed only to act: to set the calendar's city, or
  to remove it at once. These entries stay on the index's relay until the
  operator sends them outside.
- The index key follows (kind 3) every key a listed entry names in `p`,
  except a publisher listed from what it posts (or from a pasted link) whose
  organizer has not proved the key.

## Where it is published

The entries go to the index's relay, and beyond it to the list and search
relays once publishing the directory outside is turned on
([`indexer-rules.md`](indexer-rules.md) § 11). The curator's kind 10002 then
names the list relays it writes to.

The index key's events header (`39998:<index key>:events`), which every
projected event's `z` names ([`nip52-mapping.md`](nip52-mapping.md) § 2), stays
on the index's relay.
