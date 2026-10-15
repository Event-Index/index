# relay

`strfry.conf` configures the index's own relay, `wss://relay.eventindex.space`,
running [strfry](https://github.com/hoytech/strfry) 1.1.3 behind nginx.

The relay keeps everything the index publishes (calendar keys' kind 0, kind
10002, kind 31924, every 31922/31923 projection and their deletions) and accepts
any event, so RSVPs (kind 31925) and comments (kind 1111) sent to a calendar
key's inbox reach it. Each calendar key's kind 10002 names this relay unmarked
for that reason.

Limits are strfry's defaults (`maxEventSize` 65,536 bytes, `maxNumTags` 2,000),
the same order as general relays, so an event accepted here is accepted there.
The projector keeps kind 31924 calendar lists under that size.

The database lives in `/var/lib/strfry/db/` and is backed up like any strfry
database; it is history, because feeds drop past events.
