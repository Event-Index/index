# Indexer rules

Status: draft.

## 1. Which entries are polled

- The index polls the directory entries its own key filed (seeded entries and
  submissions that passed validation, § 4), unless they carry `removed`.
- A `calendar` entry is polled and projected. An `aggregator` entry is polled
  only to find calendars; its events are never projected, so an event seen only
  through an aggregator, whose host has no calendar in the directory, is not
  projected.

## 2. Discovery and seeding

- A Luma city page leads to the calendars of its events: the page's
  `__NEXT_DATA__` names each one (`api_id`, `name`, `slug`, `is_personal`,
  `access_level`). Only `public` calendars are taken.
- **Organizations, not individuals.** Automated seeding and discovery file only
  calendars an organizer created and named. A platform account's default
  calendar (Luma: `is_personal`, or the name `Personal`) is skipped and the
  skip is logged with its reason. Such a calendar enters the directory only
  when its owner submits or claims it.
- Seed lists live in `seeds/` (format in [`../seeds/README.md`](../seeds/README.md)).
- Filing many entries at once spreads their `created_at` so that no second
  holds more than 1,000 events.

## 3. Schedule

- A feed is polled every 6 hours; every hour while one of its events starts
  within 48 hours.
- Never more often than the feed's `REFRESH-INTERVAL` (or `X-PUBLISHED-TTL`),
  which is honored up to 24 hours.
- Requests are conditional (`If-None-Match`, `If-Modified-Since`) and carry
  `User-Agent: EventIndex/0.1 (+https://eventindex.space)`.
- After a failed poll the next try waits 15 minutes, doubling with each
  consecutive failure up to 24 hours, and never before the server's
  `Retry-After`.
- An entry whose polls have failed for 14 days is marked stale.

## 4. Validation of a submitted feed

A feed URL is refused when:

- it is not `http`, `https` or `webcal`;
- it carries credentials (`user:pass@`), or a query parameter named for a
  secret (`token`, `key`, `apikey`, `access_token`, `auth`, `authtoken`,
  `secret`, `sig`, `signature`, `password`, `pass`, `pwd`, `private`,
  `privatekey`, `session`, `sessionid`; compared case-insensitively, ignoring
  `-` and `_`);
- a path segment starts with `private`, `secret` or `token` followed by `-` or
  `_`, as Google's private addresses do;
- it is a member's or an account's own feed: Meetup `/events/ical/<id>/<hash>`,
  any `/events/going/` address, Outlook `/owa/calendar/` publishing links,
  iCloud `/published/` links;
- it is not a valid URL (including broken percent-encoding);
- its host resolves only to addresses that are not public (loopback, private,
  link-local, shared, documentation, benchmarking, multicast and reserved IPv4
  ranges; loopback, IPv4-compatible `::/96`, unique-local, site-local,
  link-local, multicast, documentation, Teredo and local-use NAT64 IPv6
  ranges; IPv4-mapped, NAT64 `64:ff9b::/96` and 6to4 addresses judged by their
  IPv4 address). The check applies to the address each connection is made to,
  and every redirect (at most 5) is checked again as a new URL;
- it does not answer within 60 seconds overall (redirects and body included),
  or goes 30 seconds without sending;
- its body exceeds 5 MB, is not a VCALENDAR, or holds neither a VEVENT nor a
  calendar name.

An accepted URL is canonicalized ([`icalendar-profile.md`](icalendar-profile.md) § 5).

## 5. Duplicates

Across directory calendars: [`nip52-mapping.md`](nip52-mapping.md) § 5. Within
one feed: [`icalendar-profile.md`](icalendar-profile.md) § 3.

## 6. Vanished events and quarantine

Each poll is compared with the events the calendar has published.

- **Missing.** An upcoming event (one that has not started) is withdrawn only
  when it has been missing from 3 consecutive successful polls and the first
  of those polls was at least 24 hours before the last; or, when it starts
  within 24 hours, from 2 consecutive successful polls. A poll in which it
  reappears resets the count. A failed poll (network, HTTP or parse error)
  neither counts nor resets.
- **Yielded.** An event the calendar now leaves to a co-host to sign is not
  missing: its copy is deleted at once ([`nip52-mapping.md`](nip52-mapping.md) § 5).
- **Quarantine.** A successful poll is quarantined when
  - it returns no events while upcoming events were present at the last
    successful poll, or
  - more than half of the upcoming events present at the last successful poll
    are gone, when there were at least 4. An event is gone when its `UID` is
    absent from the poll; an occurrence whose series is still there (a series
    moved to another time) is not gone. Events yielded to a co-host are not
    counted.

  A quarantined poll publishes and withdraws nothing, counts no misses, and is
  logged with its reason. The quarantine lifts at the first poll that no longer
  meets either condition. After 7 days the smaller feed is accepted: the poll
  is processed normally and the missing events start counting.
- **Withdrawal** follows [`nip52-mapping.md`](nip52-mapping.md) § 4: cancelled
  when the event has RSVPs, else deleted.
- **Past events** are never withdrawn because a feed dropped them. They are
  forgotten by the presence state once they leave the window.

## 7. History

Every projected event is a signed event: nothing in the index's databases is
needed to render one in a nostr client. Current events can be rebuilt from the
feeds; past events cannot, because feeds drop them, so `index.db` is history
and is backed up as such.

## 8. Calendar keys at rest

- Each adopted `calendar` entry gets one random key, created on first use and
  belonging to the entry's `d`. Keys are never derived from anything.
- Keys live in `vault.db`, apart from `index.db`, and are never dumped. Each is
  encrypted with XChaCha20-Poly1305 under a key derived with HKDF-SHA256 from
  the calendar-key secret (info `event-index/calendar-key/v1`), with a random
  24-byte nonce and the entry's `d` as associated data, so a ciphertext copied
  to another row does not decrypt.
- A key leaves the vault only as a signature, or, when a claim hands it to its
  organizer, as NIP-49 `ncryptsec` under the organizer's password. After a
  hand-over or a removal the key is deleted, and backups of `vault.db` are kept
  for a bounded time only, so a deleted key is eventually forgotten.
- The index key and the calendar-key secret are separate secrets.

## 9. Seeding

`scripts/seed-entries.ts` turns a seed list into unsigned directory entries
for the index key to sign: each feed is fetched and validated (§ 4), platform
default calendars are skipped (§ 2), each filed calendar's key is created, and
`created_at` is spread (§ 2).
