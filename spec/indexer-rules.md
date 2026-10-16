# Indexer rules

Status: draft.

## 1. Which entries are polled

- The index polls the directory entries its own key filed (seeded entries and
  submissions that passed validation, § 4, and a maintainer's review), unless
  they carry `removed` or their `d` is on the do-not-index list (§ 10).
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
- **Continuous discovery.** Each Luma city page is filed as an `aggregator`
  entry (its Discover feed, `…?entity=discover&id=discplace-…`, and the page
  `https://luma.com/<slug>`, under the city's area). Every 6 hours the poll
  service reads each page once, no more than one page per tick, and takes the
  calendar of every event it shows. A page that cannot be read is tried again
  an hour later; a page that shows another place than its entry's is not
  used.
  - A calendar already in the directory or on the do-not-index list is left
    alone. A platform default (`is_personal`, an account's own calendar, or
    the name `Personal`) or a calendar that is not `public` is skipped, and
    each skip is recorded once, with what the page showed of it (its event and
    hosts) for a maintainer's review; skips are never published or dumped.
  - Any other calendar is checked like a submission (§ 4) and filed when it
    passes, with no review: a calendar of a known platform, named by its
    organizer, with at least one event (§ 10). It takes the page's area and
    `found_via` the page's `d`, and is polled at the next tick (§ 10, "Poll on
    approval"). A feed with no events is tried again when the page shows it a
    day or more later; one whose feed turns out to be a platform default is
    skipped.
  - Caps: one run of one page takes at most 25 new calendars (the rest wait
    for its next run); discovery files at most 300 calendars a day, and none
    once the index holds as many calendars as its follow list may name
    (§ 11). A tick checks at most 5 feeds.
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

The poll service files a seed list's `calendars` as entries directly
(`indexer/src/admin.ts import-seeds`): each with its city's area, `location`
`<city name>, <country code>` and `g` the geohash of the city's coordinates at
precision 4, and its `found_via`. Its `skipped` calendars are not filed, nor
is any `d` on the do-not-index list. The first poll validates the feed and
creates the calendar key.

## 10. Submissions and removals

- **Submissions.** A submitted feed that passes § 4 is approved at once when
  it is an organizer's own calendar on a known platform (a Luma calendar, a
  Meetup group, a public Google calendar, a Mobilizon group), named by its
  organizer rather than a platform default, with at least one event; at most
  50 such approvals a day, each logged. Any other waits in a review queue (at
  most 1,000), where a maintainer files it or rejects it; a platform default
  calendar is marked as such for the review. A feed already in the directory
  or on the do-not-index list is not queued. An approval by the index can be
  undone: the calendar is then removed as below.
- **Poll on approval.** An approved calendar has no poll history, so the next
  tick polls it before any other and publishes its events.
- **Remove requests.** Anyone may ask for a calendar's removal, with an
  optional message. Each request gets a token (`eventindex-remove-` and 10
  characters of `a-z2-7`); when a poll finds the token anywhere in the feed,
  the request is marked verified, as proof that its author controls the
  calendar. A maintainer approves or rejects every request, verified or not.
- **Removal.** At its next tick after the approval, the poll service, with the
  calendar key:
  - deletes every upcoming projection (kind `5`, [`nip52-mapping.md`](nip52-mapping.md) § 4),
    with or without RSVPs;
  - publishes the kind 0 of the removed state ([`nip52-mapping.md`](nip52-mapping.md) § 6)
    and a kind 31924 listing only its past events;
  - deletes the calendar key from the vault (§ 8).

  The entry is republished with `["removed", "organizer request"]`, its events
  leave the API, its `d` goes on the do-not-index list, and the feed is never
  polled again. Past events stay on relays as they were published.

## 11. The poll service

- One process per data directory, held by a lock file; a second one refuses
  to start.
- Every 30 seconds a tick carries out approved removals, polls the entries
  that are due (at most 20 per tick, the longest due first), publishes the
  index key's events that changed (its kind 0, 3 and 10002, the events list
  header, and every directory entry with a calendar key, or none for an
  aggregator; [`directory.md`](directory.md)), and
  writes the dump once a day. One feed's failure does not stop the others.
- Events go to the index's own relay; a publish it refuses fails the poll,
  which is retried. The relay accepts only the keys in the allowlist the
  service keeps ([`relay.md`](relay.md)): the index key, each calendar key
  (named before its first events go out) and removed calendars' keys.
- Publishing beyond the index's own relay is off unless the operator turns it
  on. Then each event also goes to the sets of relays its kind calls for.
  Every relay has a queue of its own, drained at its set's pace: a small
  burst, then a steady rate (a general relay: three events, then one every
  three seconds):

  | Kind | Search relays | List relays | Profile relays | General relays |
  |---|---|---|---|---|
  | 39999 (the directory's entries)¹ | yes | yes | | |
  | 0, 10002 (any key) | yes | | yes | yes |
  | 3 (the index key's follow list) | yes | | yes | yes |
  | 31924 | yes | | | yes |
  | 31922, 31923 | yes, in the window | | | while upcoming |
  | 5 | yes | | | yes |

  ¹ Only once publishing the directory outside is turned on of its own;
  until then the entries stay on the index's relay. A list header the index
  key signs (the events header) stays on its relay.

  Each relay gets, once, what the index's relay holds of the kinds its set
  takes (deletions excepted; the directory's kinds once the directory goes
  outside), so past events reach the search relays and never the general
  relays, and a relay added later gets it too. A relay that answers
  `rate-limited` or `banned` is paused for 24 hours and keeps its queue; after
  the pause it is tried again at half its pace, and a second such answer
  leaves it off until the operator resumes it. Pauses are kept in
  `index.db`. Other refusals are logged. The index key's kind 0 and 10002 go
  to the profile and general relays even while outside publishing is off.
- The index key's kind 3 follows the calendar keys the index holds (`p` with
  the index relay as hint), at most 1,900 of them: relays keep a list of at
  most 2,000 tags. Past that, the calendars filed first stay followed and
  later ones are not added; the service logs, once a day, when the list is
  within 10% of the cap or past it. A removed calendar is unfollowed.
- On SIGTERM the service stops after the poll in progress.
