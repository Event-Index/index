# The index relay

Status: draft.

`wss://relay.eventindex.space` holds what Event Index signs and the answers to
it. It accepts a client's event only when one of these holds; any other event
is refused with an `OK` message beginning `blocked: `.

| Author | Kinds |
|---|---|
| the Event Index key | 0, 3, 5, 10002, 31922, 31923, 31924, 39998, 39999 |
| a calendar key the index holds | 0, 5, 10002, 31922, 31923, 31924 |
| a removed calendar's key | 0, 5 |

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
to the relay's allowlist before publishing. A removed calendar's key keeps
kinds 0 and 5, so its removal ([`indexer-rules.md`](indexer-rules.md) § 10) and
any later deletion can be published.

Events the operator loads (`strfry import`, `sync`, `stream`) are not
filtered. The relay's NIP-11 `description` states this scope.
