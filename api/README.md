# api

The HTTP service at `https://api.eventindex.space/api/1.0/`. The routes, the
public event id, the response formats and the data terms are specified in
[`../spec/api.md`](../spec/api.md). It serves records through the projections
in `indexer/src/project/` (`.ics`, jCal, schema.org JSON-LD) and reads the
directory and poll state from `index.db`.
