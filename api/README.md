# api

The HTTP service: the API at `https://api.eventindex.space/api/1.0/`, NIP-05
names at `https://eventindex.space/.well-known/nostr.json`, and the pages of
`eventindex.space` (the directory's page, search, each calendar's page with
its claim and remove forms, and the page that adds a calendar by its nostr
key). The routes, the public event id, the response formats and the data
terms are specified in [`../spec/api.md`](../spec/api.md).

It reads `index.db`, which the poll service (`indexer/src/main.ts`) keeps, and
writes only to its review queues: submitted feeds, remove requests and claims
wait for a maintainer (`indexer/src/admin.ts`), and organizers' own requests
for the poll service. It holds no key and no secret: a signer's address an
organizer gives is sealed to the poll service's intake key as it arrives.
Requests made with an organizer's key are checked as NIP-98 proofs; filing a
calendar by its key reads that key's relays. Events are served through the
projections in `indexer/src/project/` (`.ics`, jCal, schema.org JSON-LD), so
every response follows the source's content policy.

```sh
node api/src/main.ts    # settings from the environment, see ../deploy/templates/eventindex.env
```

The pages are plain HTML with one stylesheet, nothing loaded from elsewhere.
Only the pages where organizers sign in with their nostr key run a script,
the site's own (`site/claim.js`), which talks only to the site.
