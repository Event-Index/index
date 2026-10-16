# spec

The rules the index follows, written so another implementation can follow them.

| Document | What it specifies |
|---|---|
| [`icalendar-profile.md`](icalendar-profile.md) | the record: what is kept from a feed, what the index adds, directory identity, public event ids |
| [`platform-adapters.md`](platform-adapters.md) | how each platform's feeds are read |
| [`nip52-mapping.md`](nip52-mapping.md) | how a record becomes NIP-52 events and the calendar key's other events, and how an organizer's own NIP-52 events become records |
| [`indexer-rules.md`](indexer-rules.md) | which feeds are polled, when, and what happens when events change or vanish; calendars read from their organizers' keys; claims |
| [`directory.md`](directory.md) | the directory on nostr: the maintainer's list header, the curator's entries |
| [`relay.md`](relay.md) | what the index's relay accepts |
| [`api.md`](api.md) | the HTTP API and its data terms |

The nostr wire format (the events list header, calendar keys, the claim and
remove flows) is specified as a protocol draft outside this repository;
`nip52-mapping.md` follows it. The directory's list header is a maintainer's
(`directory.md`).

Status: draft.
