# spec

The rules the index follows, written so another implementation can follow them.

| Document | What it specifies |
|---|---|
| [`icalendar-profile.md`](icalendar-profile.md) | the record: what is kept from a feed, what the index adds, directory identity, public event ids |
| [`platform-adapters.md`](platform-adapters.md) | how each platform's feeds are read |
| [`event-items.md`](event-items.md) | how the index lists events on nostr: an item of the Events list per upcoming event, signed by the index key |
| [`nip52-mapping.md`](nip52-mapping.md) | the projection window and summary; the NIP-52 events the index signs as an organizer, through their signer; how an organizer's own NIP-52 events become records |
| [`indexer-rules.md`](indexer-rules.md) | which feeds are polled, when, and what happens when events change or vanish; calendars read from their organizers' keys; claims |
| [`directory.md`](directory.md) | the directory on nostr: the maintainer's list header, the curator's entries |
| [`relay.md`](relay.md) | what the index's relay accepts |
| [`api.md`](api.md) | the HTTP API and its data terms |

The nostr wire format (the events list header, the claim and remove flows) is specified as a protocol draft outside this repository;
`nip52-mapping.md` follows it. The directory's list header is a maintainer's
(`directory.md`).

Status: draft.
