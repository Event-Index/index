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
- A calendar its organizer publishes from their own key (a native calendar,
  or one claimed to publish itself; [`directory.md`](directory.md)) is not
  polled: its organizer's events are read instead, on the same schedule
  (§ 12). A publisher the index listed from what it posts is not read on its
  own either: its events come in with every other NIP-52 event (§ 14).

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
    once the index key follows as many keys as its follow list may name
    (§ 11; publishers listed from what they post are not followed). A tick
    checks at most 5 feeds.
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
- `vault.db` also keeps, for a calendar the index publishes as its organizer,
  the connection to their remote signer (§ 13): the index's own client key
  for it and the signer's key, relays and secret, encrypted the same way under
  a key of its own (info `event-index/signer-connection/v1`), with the entry's
  `d` and the organizer's key as associated data. It is deleted when the
  organizer disconnects the signer, or the calendar is removed.
- Organizers seal what they hand the index for the poll service alone (a
  signer's address) with NIP-44 to the **intake key**, a key derived from the
  calendar-key secret (info `event-index/intake/v1`) whose public key the poll
  service writes to `index.db`; the HTTP service seals, and only the poll
  service can open it.
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
  characters of `a-z2-7`); when a poll finds the token in what the organizer
  writes in the feed (the calendar's name or description, or an event's title
  or description, its folded lines joined; never an attendee's name, a place
  or a link, which others may write), the request is marked verified, as
  proof that its author controls the calendar. A maintainer approves or
  rejects every request, verified or not.
- **By the calendar's own key.** A remove request signed (NIP-98) with the
  key a calendar is published with (an organizer's own key: a native
  calendar, or a claimed one) is approved at once, without review, and
  carried out at the next tick. A calendar key the index holds cannot sign
  one, so a mirrored calendar's removal is always reviewed.
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

  A calendar its organizer publishes (§§ 12, 13) has no calendar key left to
  sign with: its removal retires the entry, forgets any signer connection,
  drops the events the index kept of that key, and puts `nostr:<their key>`
  on the do-not-index list, so the key is not listed again from what it
  posts (§ 14). Its organizer's events stay theirs.

## 11. The poll service

- One process per data directory, held by a lock file; a second one refuses
  to start.
- Every 30 seconds a tick carries out approved removals, then approved claims
  and organizers' own requests (§ 13), polls the entries that are due (at most
  20 per tick, the longest due first; a calendar its organizer publishes is
  read instead, § 12), reads what is new among public NIP-52 events and
  builds the records of publishers whose events changed (§ 14), marks copies
  (§ 15), publishes the index key's events that changed (its kind 0, 3 and
  10002, the events list header, and every directory entry with a key, or
  none for a feed aggregator; [`directory.md`](directory.md)), and writes the
  dump once a day. One feed's failure does not stop the others.
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
- The index key's kind 3 follows every key a listed entry names in `p` (`p`
  with the index relay as hint): the calendar keys it holds, organizers'
  own keys, and a claimed calendar's old key while events it signed are
  still to come. A publisher listed from what it posts, or from a link
  someone pasted, is not followed until its organizer proves the key (§ 12).
  It names at most 1,900 keys: relays keep a list of at most 2,000 tags.
  Past that, the calendars filed first stay followed and later ones are not
  added; the service logs, once a day, when the list is within 10% of the cap
  or past it. A removed calendar is unfollowed.
- **Paused calendar keys.** The operator can pause calendar keys. While they
  are paused, no calendar key is made: a calendar without one is still polled
  and its records, events and pages are served, but nothing is projected or
  signed for it and its directory entry waits for its key. A calendar that
  has a key signs only deletions, on the index's relay: a withdrawal its
  source calls for; no new or changed event, calendar, profile or relay
  list. What else changed is held, the feed's validators are dropped, and the
  first poll after the pause publishes it from the feed read in full (a held
  cancellation is decided again then). Its records, events and pages follow
  the feed meanwhile. Nothing a calendar key signs goes to the outside
  relays or is sent to them again. No calendar key is deleted: a removal or
  a claim deletes the calendar's events on the index's relay, signs nothing
  else there, keeps its key, and the key clears the
  calendar from the outside relays (search, general and profile relays): a
  last kind 0 with the name `Retired Event Index mirror`, no `nip05`,
  `website` or `picture`, and an `about` naming the calendar's page; and a
  kind 5 for every 31922, 31923 and 31924 it signed, naming each version's
  `e`, then the `a` and the `k`. The clearing is resent after a restart
  until the outside relays have taken it. When the pause ends, keys are made
  at each calendar's next poll and the outside relays get what they missed.
- On SIGTERM the service stops after the poll in progress.

## 12. Calendars published by their organizers

A native calendar, or one whose organizer claimed it to publish it themselves
(§ 13), is read by its organizer's key. The index signs nothing for it but
its directory entry.

- **Where.** The organizer's relay list (their newest kind 10002) is read
  from the index's usual relays: its own relay, the general relays and the
  profile relays. Their events are then read from their write relays (those
  marked `write` or unmarked, at most 4, the usual ones among them included)
  and the usual relays, each relay asked once. A relay the
  organizer names is used only when it is `wss` on a host that resolves only
  to public addresses (§ 4's ranges), so an organizer cannot point the index
  at its own network.
- **What.** Their kinds 0, 5, 31922, 31923 and 31924, at most 5,000. Only
  events with the organizer's valid signature count; the newest version of
  each address wins (later `created_at`, then the lower id). An event the
  organizer deleted (a kind 5 naming its id, or its address with a
  `created_at` no earlier than the event's) is left out.
- **The records.** Each 31922 and 31923 becomes a record by
  [`nip52-mapping.md`](nip52-mapping.md) § 8, and the records replace the
  calendar's events in the API at each read. A read no relay answers is a
  failed poll (§ 3's backoff, § 3's staleness); what was read before stays.
- **The entry.** A native calendar's name, description, image and page come
  from the organizer's profile (`display_name`, else `name`; `about`;
  `picture`; `website`) and their newest kind 31924 (its `title` when the
  profile has no name; its content as the description). A claimed calendar
  keeps its name and description from its feed. The entry's `calendar` names
  the organizer's newest kind 31924, when they have one.
- **Listing.** No proof is needed to be listed: the index lists every
  publisher it reads once it has an upcoming event (§ 14), and anyone may
  paste a publisher's npub, nprofile or NIP-05 address as a submission, which
  lists it at once when its relays hold an upcoming NIP-52 event from it, and
  keeps it without a listing (§ 14) when they hold only past ones. Its `d`
  is `nostr:<their hex key>`
  ([`icalendar-profile.md`](icalendar-profile.md) § 5), and no calendar key is
  made for it.
- **The organizer's key.** Proof is needed to act on it: a request signed
  with the publisher's key ([`api.md`](api.md), "Requests signed with your
  key") lists it at once, upcoming events or not, as its organizer asks, or,
  when it is filed, lists it and sets its city; it is then
  read from the organizer's own relays as well, and followed by the index key
  (§ 11). Signed with that key, a remove request is carried out at once
  (§ 10).

## 13. Claims

An organizer who already publishes on nostr can claim a calendar the index
mirrors, so that its events are published from their own key.

- **Proof of the key.** The claim is a request signed with the organizer's
  key (NIP-98, [`api.md`](api.md)), so their key is proven when they make it.
- **Proof of the calendar**, either of:
  - a **token** (`eventindex-claim-` and 10 characters of `a-z2-7`) given with
    the claim, which the organizer places in the calendar's description or in
    one of its events; the claim is verified when a poll finds it where a
    remove token is looked for (§ 10);
  - **NIP-05** at the calendar's own domain naming the organizer's key: the
    feed's host for a feed on the organizer's own site, or the host of the
    calendar's page, never a platform's (Luma, Meetup, Google, nor the
    instance of a Mobilizon or Gancio group). A leading `www.` is ignored.
- **One key, which calendars.** A key that publishes a calendar itself (a
  native calendar, or one claimed in `own` mode) owns no other listed
  calendar, since the index reads every event of that key as that calendar's.
  A key the index publishes as (`delegated`) may have several calendars. A
  removed calendar does not count. This is checked when a calendar is filed
  or claimed, when a maintainer approves it, and when the poll service
  carries it out.
- **Review.** A maintainer approves a claim only once it is verified, and may
  reject any. The poll service carries out an approved claim at its next
  tick; one it cannot carry out yet (no relay answers for the organizer) is
  tried again at each tick, and fails a day after its approval.
- **Modes.** The organizer chooses one when they claim:
  - **`own`, "I publish myself".** The index stops polling the feed and reads
    the organizer's events instead (§ 12).
  - **`delegated`, "publish for me, as me".** The organizer gives the address
    of a remote signer (NIP-46, `bunker://<signer key>?relay=…&secret=…`),
    sealed to the intake key (§ 8). The index connects with a client key of
    its own, asks for permission to sign kinds 31922, 31923, 31924 and 5 only,
    and checks that the signer signs as the claimant. It then keeps polling
    the feed and signs the calendar's events with the organizer's key
    ([`nip52-mapping.md`](nip52-mapping.md) § 7). It asks the signer for no
    other kind, and checks that every event it gets back is the one it asked
    for, signed by the organizer. A claim whose signer does not answer, signs
    as another key, or names no relay the index will connect to (§ 12's rule)
    fails, and the calendar stays as it was. Each request to the signer may
    take 30 seconds; a poll signs at most 100 events through it, within two
    minutes, and the rest a minute later, at the next poll. While the signer
    does not answer, the calendar's polls fail and back off (§ 3), and nothing
    is signed for it.
- **The calendar key retires**, either way, before anything is signed as the
  organizer: its upcoming events are withdrawn (republished as cancelled where
  they have RSVPs, else deleted; [`nip52-mapping.md`](nip52-mapping.md) § 4).
  A cancelled copy names the organizer's own copy of the event with
  `["q", "<kind>:<organizer>:<d>", "<relay>"]`: in `delegated` mode the same
  `d` under the organizer's key; in `own` mode the organizer's event with the
  same page (`r`), or the same `start` and title. Its kind 0 and 31924 say
  where the calendar now publishes ([`nip52-mapping.md`](nip52-mapping.md) § 6),
  and the key is deleted from the vault. On the index's relay the old key
  keeps kinds 0 and 5 ([`relay.md`](relay.md)).
- **After.** The entry names the organizer's key first and the old key second
  while events it signed are to come ([`directory.md`](directory.md)). In
  `own` mode, the old records the organizer's own events replace carry
  `X-EVENTINDEX-CANONICAL` with the replacement's URL, and every record of a
  claimed calendar carries `X-EVENTINDEX-CLAIMED`
  ([`icalendar-profile.md`](icalendar-profile.md) § 3.5).
- **The organizer's own requests.** Once a calendar is theirs, its organizer
  can disconnect the signer (the index forgets the connection and reads their
  events from then on, as in `own` mode) or connect one (the index publishes
  the feed as them again, for a calendar that has a feed). These are signed
  with their key and need no review.
- **Hosting.** While the operator has the index's relay host claimants
  (`RELAY_HOSTS_CLAIMANTS=1`, as `relay.eventindex.space` does;
  [`relay.md`](relay.md)), the events the index signs as an organizer go to
  its relay as well as to the organizer's write relays, and name it as their
  relay hint. Otherwise they go to the organizer's write relays, or to the
  general relays when the organizer names none. An organizer who publishes
  from their own key themselves is never hosted.

## 14. Every public NIP-52 event

When the operator turns it on (`INGEST_NOSTR`), the index reads every
public NIP-52 calendar event (kinds 31922 and 31923) by kind, the bridge's
other direction at full width.

- **Where.** The search relays (by default those the index publishes to,
  asked with the `include:spam` extension, as plain reads there need) and
  the large public relays (by default `wss://relay.damus.io`, `wss://nos.lol`,
  `wss://relay.primal.net` and `wss://relay.formstr.app`).
- **How.** Each relay's history is read page by page (500 events, `until`
  set to the oldest second of the last page, so events sharing a second are
  not skipped; a page that does not get past it moves on), at most 8 pages
  per relay per tick, a pause between pages. Then what is new is asked every
  five minutes (`since` an hour before the newest event seen), and the whole
  history again each week, for what a sync missed (events published late,
  or dated back). A relay that does not answer is asked again at the next
  tick.
- **What is kept.** Every event whose signature checks, with a `d`, a title
  (or the older `name`) and a readable start between 1990 and ten years
  ahead. Trust is a reader's concern, so nothing else is judged. Left out:
  what the index signs itself (its calendar keys' events, and any event of
  a key that owns no listed calendar carrying the index's events header),
  events of a key whose secret is public (the key of secret 1), and
  publishers removed at their request. Each event is kept as it was signed,
  the newest version of each address (later `created_at`, then the lower
  id). The index never signs or sends these events: they already live on
  nostr.
- **Deletions.** The publishers' kind 5 events naming 31922 or 31923 in `k`
  are read the same way. A deletion by its author removes the event it names
  by id, and by address every version no newer than the deletion; it is
  remembered, so an older copy read later, or the same event from another
  relay, stays deleted. A deletion by anyone else does nothing.
- **Listing.** Every key with an event kept is filed in the directory by the
  index key as curator, with no review: `d` `nostr:<key>`, `source`
  `nostr`, `p` the publisher, named from its profile (`display_name`, else
  `name`; checked weekly; else its npub, shortened), its `about`, `picture`
  and `website` as description, image and page. It is listed (it gets a
  directory entry, kind 39999, and shows in the API's lists, search and
  counts and on the site) once it has an upcoming event: one whose start is
  still to come. Until then it is kept without a listing: its events and
  records are served (`GET /calendars/byslug/<local name>` and its page
  still answer, with `listed: false`), but it has no directory entry. Once
  listed it stays listed: when its events have all passed, its entry is
  neither withdrawn nor changed, so lists do not churn as publishers come
  and go; it leaves only on removal (§ 10, § 12). A key in
  `seeds/nostr-aggregators.json` (publishers of other organizers' events
  under their own key, such as Club Orange) is listed with the role
  `aggregator`; its events are kept and attributed to it. A key that owns a
  listed calendar has its events read into that calendar instead (one it
  claimed to publish itself, or filed by its key); a key the index publishes
  as (`delegated`) is not listed from its events.
- **Records.** A publisher's records are built from what is kept, whenever
  its events change, all of them and not only the projection window, and the
  API serves past ones too.
- **Where its entry goes.** Entries listed this way, or from a pasted link,
  stay on the index's relay until the operator sends them to the list and
  search relays too (`PUBLISH_NOSTR_ENTRIES_OUTSIDE`). Before a tick sends
  any there, the service logs how many it sends, how many publishers are
  listed and how many are kept without a listing. Like every directory
  entry, their `created_at` are a second apart, counting back from now.

## 15. Copies and originals

The same event can reach the index more than once: an organizer's own
NIP-52 event, the same event in a feed the index mirrors, and an aggregator's
copy. The more original one is canonical: an organizer's own event (a
calendar published from its own key) over a feed's, and either over an
aggregator's.

- **The same event**: starts within half an hour of each other; the same
  title, compared lowercased, without accents, punctuation or a
  `Cancelled: ` prefix (or, for titles of 12 characters or more, one held
  whole in the other); and, when both carry coordinates, in the same
  5-character geohash cell (or the coarser one's cell). Events of one
  calendar, or of two organizers' own calendars, are never copies.
- **Which original**: the most original kind, then the closest start, then
  the lowest public id. Deterministic.
- **Marked** at each tick, among the events from 30 days ago on: the copy's
  `canonical` in the API and its record's `X-EVENTINDEX-CANONICAL` name the
  original; a mirrored projection that copies an organizer's own event names
  it with `q` ([`nip52-mapping.md`](nip52-mapping.md) § 2). A copy whose
  original is gone stands on its own again.

