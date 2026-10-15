# spec

The rules the index follows, written so another implementation can follow them.

| Document | What it specifies |
|---|---|
| [`icalendar-profile.md`](icalendar-profile.md) | the record: what is kept from a feed, what the index adds, directory identity, public event ids |
| [`platform-adapters.md`](platform-adapters.md) | how each platform's feeds are read |
| [`nip52-mapping.md`](nip52-mapping.md) | how a record becomes NIP-52 events and the calendar key's other events |
| [`indexer-rules.md`](indexer-rules.md) | which feeds are polled, when, and what happens when events change or vanish |
| [`api.md`](api.md) | the HTTP API and its data terms |

The nostr wire format (the directory and events list headers, calendar keys,
the claim and remove flows) is specified as a protocol draft outside this
repository; `nip52-mapping.md` follows it.

Status: draft.
