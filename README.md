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

The directory itself is a decentralized list on nostr, and its data is in the
public domain.

Status: early, not yet running in public. Implemented and tested against
captured feeds and a local relay: the normalizer, the platform adapters (Luma,
Meetup, Mobilizon, Google), the projector (NIP-52, `.ics`, jCal, JSON-LD and
the calendar keys' own events), the indexer rules (co-hosts, vanished events,
quarantine, schedule, submission checks), the poll service
(`indexer/src/main.ts`), which publishes the directory and carries out
removals, the maintainer's commands (`indexer/src/admin.ts`), and the HTTP
service (`api/src/main.ts`): the API, NIP-05 names and the pages of
eventindex.space. Not implemented: discovery through aggregator feeds,
claims, and native NIP-52 calendars.

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
