# The index relay

Status: draft.

`wss://relay.eventindex.space` holds what Event Index signs and the answers to
it. It accepts a client's event only when one of these holds; any other event
is refused with an `OK` message beginning `blocked: `.

| Author | Kinds |
|---|---|
| the Event Index key | 0, 3, 5, 10002, 31922, 31923, 31924, 39998, 39999 (the directory's entries and, with event items, an item per upcoming event: thousands, in bulk) |
| a calendar key the index holds | 0, 5, 10002, 31922, 31923, 31924 |
| a removed or claimed calendar's old key | 0, 5 |
| an organizer the index publishes as, through their signer, while the operator has the relay host them (`RELAY_HOSTS_CLAIMANTS=1`; `relay.eventindex.space` does) | 5, 31922, 31923, 31924 |

From anyone:

- **RSVP** (kind 31925): an `a` tag names a kind 31922 or 31923 event of one of
  the keys above (`<kind>:<hex key>:<d>`).
- **Comment** (kind 1111, NIP-22): its root scope names such an event: an `A`
  tag, or, when it has no `A`, an `a` tag.
- **Deletion** (kind 5): every `e` names an event by the deletion's author
  stored on the relay, and every `a` names an addressable event of the
  author's (`<kind>:<author>:<d>`) stored on the relay. A deletion with neither
  is refused.

A calendar key is accepted from before its first event: the indexer adds it
to the relay's allowlist before publishing. A removed or claimed calendar's
old key keeps kinds 0 and 5, so its removal ([`indexer-rules.md`](indexer-rules.md) § 10),
its claim (§ 13 there) and any later deletion can be published. An
organizer's own key is never given kinds 0 or 10002: their profile and relay
list are theirs. An organizer who publishes from their own key themselves is
not hosted: their events live on their own relays. While the relay hosts an
organizer the index publishes as, the events the index signs as them go to
it as well as to their own relays, and a deletion of theirs is taken here
too; when it does not, those events go to their own relays only.

Events the operator loads (`strfry import`, `sync`, `stream`) are not
filtered. The relay's NIP-11 `description` states this scope.
