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
| `role` | `calendar`, or `aggregator` for a feed that only leads to calendars |
| `p` | the calendar key (hex); none for an aggregator |
| `index-name` | the calendar's local name: its page is `eventindex.space/calendar/<name>`, its NIP-05 name `<name>@eventindex.space` |
| `feed` | the feed URL the calendar is read from |
| `source` | `luma`, `meetup`, `mobilizon`, `gancio`, `google`, `ics` or `nostr` |
| `location` | the calendar's area, `<city>, <country code>` |
| `g` | the area's geohash |
| `luma-id` | for a Luma calendar: its id, `cal-…` |
| `meetup-group` | for a Meetup group: the group's name in its address |
| `calendar` | for a native calendar: its kind 31924's coordinate |
| `t` | the city's slug (`san-diego`), then the source; repeats |
| `description` | the calendar's description, where the source's content policy serves descriptions ([`platform-adapters.md`](platform-adapters.md)) |
| `image` | the calendar's image, where the source's content policy serves images |
| `removed` | for a calendar removed at its organizer's request: `organizer request` ([`indexer-rules.md`](indexer-rules.md) § 10) |

`content` is empty. Entries are republished when they change, with
`created_at` one second apart.

## Where it is published

The entries go to the index's relay, and beyond it to the list and search
relays once publishing the directory outside is turned on
([`indexer-rules.md`](indexer-rules.md) § 11). The curator's kind 10002 then
names the list relays it writes to.

The index key's events header (`39998:<index key>:events`), which every
projected event's `z` names ([`nip52-mapping.md`](nip52-mapping.md) § 2), stays
on the index's relay.
