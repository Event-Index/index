# api

The HTTP service: the API at `https://api.eventindex.space/api/1.0/`, NIP-05
names at `https://eventindex.space/.well-known/nostr.json`, and the pages of
`eventindex.space` (the directory's page, search, each calendar's page with
its remove form). The routes, the public event id, the response formats and
the data terms are specified in [`../spec/api.md`](../spec/api.md).

It reads `index.db`, which the poll service (`indexer/src/main.ts`) keeps, and
writes only to its review queues: submitted feeds and remove requests wait for
a maintainer (`indexer/src/admin.ts`). It holds no key. Events are served
through the projections in `indexer/src/project/` (`.ics`, jCal, schema.org
JSON-LD), so every response follows the source's content policy.

```sh
node api/src/main.ts    # settings from the environment, see ../deploy/templates/eventindex.env
```

The pages are plain HTML with one stylesheet: no scripts, no images, nothing
loaded from elsewhere.
