# Event Index

An open directory of public event calendars.

Event Index keeps a directory of public iCalendar feeds (an organizer's
calendar on Luma, a Meetup group, a Mobilizon group, a public Google calendar,
any `.ics` URL), polls each feed, and keeps every event as a normalized
iCalendar record. It serves each record as:

- **iCalendar** (`.ics`, RFC 5545, with RFC 7986 calendar properties),
- **jCal** (RFC 7265),
- **schema.org/Event JSON-LD**, and
- **NIP-52 calendar events** (kinds 31922 and 31923) on nostr relays, signed by
  one key per calendar, so each event shows its own organizer as host.

The bridge runs both ways. The index reads every public NIP-52 event by
kind from the relays that carry them, keeps each as its publisher signed it,
and serves it as `.ics`, jCal and JSON-LD, signing nothing; every publisher
with an upcoming event is listed in the directory, and stays listed, and the
index marks an aggregator's copy of an organizer's own event as a copy. An organizer whose calendar the index
mirrors can claim it, to publish its events from their own key: themselves,
or by the index, as them, through a remote signer they connect (NIP-46).
Anyone can add a calendar by pasting a link to it, to one of its events, or
to its publisher on nostr.

The directory itself is a decentralized list on nostr: a maintainer signs its
header, and the index key, as its curator, signs one entry per calendar
([`spec/directory.md`](spec/directory.md)). Its data is in the public domain.

Status: early. Implemented and tested against captured feeds and local
relays: the normalizer, the platform adapters (Luma, Meetup, Mobilizon,
Google), the projector (event items, `.ics`, jCal, JSON-LD, and NIP-52 for a
calendar published as its organizer), the indexer rules (co-hosts, vanished events, quarantine,
schedule, submission checks), every public NIP-52 event read by kind,
publishers listed and copies marked, claims with an organizer's own key
(publishing themselves, or through their signer), links resolved to the
calendars they name, the poll service (`indexer/src/main.ts`), which publishes the
directory and carries out removals and claims, the maintainer's commands
(`indexer/src/admin.ts`), and the HTTP service (`api/src/main.ts`): the API,
the index key's NIP-05 name and the pages of eventindex.space. Not
implemented: discovery through aggregator feeds.

## Layout

| Path | What it holds |
|---|---|
| `indexer/` | the poll service, the normalizer, the platform adapters, the projector and the maintainer's commands |
| `api/` | the HTTP service: the API, NIP-05 names and the pages |
| `relay/` | the index's own relay (strfry): its configuration and write policy |
| `deploy/` | scripts and runbook for a server: setup, backups, upgrades, restore |
| `spec/` | the iCalendar profile, the platform adapters, the NIP-52 mapping, the relay's write policy, the API reference |
| `seeds/` | organizer calendar lists by platform and city |
| `brand/` | the mark, the wordmark and the favicon set, with the tools that generate them |
| `fixtures/` | captured and synthetic feeds the tests run against |
| `scripts/` | maintenance tools |

## Using the index

The API is versioned under `https://api.eventindex.space/api/1.0/` and is
specified in [`spec/api.md`](spec/api.md). Read endpoints need no key. Every
response credits the organizer and the platform the event comes from and links
back to the event's own page; keep that attribution when you reuse event
content.

## Running it

Requires Node.js 22.18 or later (TypeScript runs through Node's type stripping;
there is no build step).

```sh
npm install
npm test
npm run typecheck
```

To run a server, see [`deploy/README.md`](deploy/README.md).

## Licenses

- Code: Apache License 2.0 ([`LICENSE`](LICENSE)).
- Directory data (entries, calendar metadata, poll statistics, seed lists):
  CC0 1.0 ([`seeds/LICENSE`](seeds/LICENSE)).
- The Event Index mark and wordmark ([`brand/`](brand/README.md)): CC0 1.0
  ([`brand/LICENSE`](brand/LICENSE)). The typeface, Public Sans, is under the
  SIL Open Font License 1.1 ([`brand/fonts/OFL.txt`](brand/fonts/OFL.txt)).
- Event content remains its organizers'.

## Credits

- [NosFabrica](https://nosfabrica.com) is a core maintainer of Event Index.
- [Brainstorm](https://brainstorm.world) is one consumer of the index.
