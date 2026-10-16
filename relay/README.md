# relay

`strfry.conf` configures the index's own relay, `wss://relay.eventindex.space`,
running [strfry](https://github.com/hoytech/strfry) 1.1.3 behind nginx.

The relay is the home of what Event Index signs and the inbox for answers to
it, nothing more. Its write policy ([`../spec/relay.md`](../spec/relay.md))
accepts:

- from the Event Index key: kinds 0, 3, 5, 10002, 31922, 31923, 31924, 39998
  and 39999;
- from each calendar key the index holds: kinds 0, 5, 10002, 31922, 31923 and
  31924; from a removed calendar's key, kinds 0 and 5 only;
- from anyone: an RSVP (kind 31925) whose `a` names an event of one of those
  keys, a comment (kind 1111) whose root `A` names one, and a deletion (kind 5)
  of the author's own events stored here.

Everything else is refused with a `blocked:` message. Each calendar key's kind
10002 names this relay unmarked, so RSVPs and comments sent to its inbox reach
it.

The policy is a strfry write policy plugin: `write-policy` (run by strfry, as
`relay.writePolicy.plugin` names it) starts `src/plugin.ts`, which decides with
`src/policy.ts`. The keys come from an allowlist file the poll service keeps
(`EVENTINDEX_RELAY_ALLOWLIST`, default
`/var/lib/eventindex/relay-allowlist.json`); the plugin reads it again
whenever it changes, so a new calendar's key is accepted without a restart.
The service names each key in the file before that key's first events go out.
Deletions are checked against the relay itself (`EVENTINDEX_RELAY_URL`,
default `ws://127.0.0.1:7777`). Events the operator loads with `strfry
import`, `sync` or `stream` are not filtered.

The relay takes events of up to 512 KB (`maxEventSize` 524,288 bytes, in
websocket frames of up to 1 MiB) with up to 2,000 tags (`maxNumTags`), more
than general relays take, so its own limit is never the tightest. What the
index publishes stays within what the other relays take: kind 31924 calendar
lists stay under 65,536 bytes, and the index key's kind 3 within the 2,000-tag
cap of the search relay and of purplepag.es.

The database lives in `/var/lib/strfry/db/` and is backed up like any strfry
database; it is history, because feeds drop past events.

## Tests

`relay/test/policy.test.ts` and `plugin.test.ts` run with `npm test`.
`strfry.test.ts` runs the poll service against strfry with the plugin in a
container, and is skipped until its image is built:

```sh
docker build -t eventindex-strfry-test -f relay/test/strfry.Dockerfile relay/test
```
