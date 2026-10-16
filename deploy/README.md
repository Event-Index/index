# deploy

Scripts and runbook for one Event Index server: Ubuntu 24.04 LTS on any
provider (2 vCPU, 4 GB, 80 GB is enough), with backups in any S3-compatible
bucket. Nothing in them is specific to a hosting provider.

| Hostname | Serves | Behind nginx |
|---|---|---|
| `eventindex.space` | the page, search, calendar pages (`/calendar/…`), NIP-05 names (`/.well-known/nostr.json`) | the API on `127.0.0.1:8080`; a static page while it is down |
| `api.eventindex.space` | the API (`/api/1.0/…`) | `127.0.0.1:8080` |
| `relay.eventindex.space` | the relay, `wss://` | strfry on `127.0.0.1:7777` |

## What the setup installs

- **Base system**: the `eventindex` service user, `ufw` allowing only 22, 80
  and 443, unattended security upgrades, a swap file (`SWAP_SIZE`).
- **Node.js** (`NODE_VERSION`) from nodejs.org, checked against its pinned SHA-256.
- **strfry** (`STRFRY_VERSION`) built from source at its pinned commit, with
  `relay/strfry.conf`.
- **nginx** with one Let's Encrypt certificate for the three names (certbot,
  renewed by `certbot.timer`, nginx reloaded after each renewal), including the
  WebSocket proxy for the relay.
- **systemd units**: `strfry`, `eventindex-indexer`, `eventindex-api`,
  `litestream`, `eventindex-relay-export.timer` (nightly), and, while
  `COVERAGE_PUBKEY` is set, `eventindex-coverage.timer` (daily).
- **Litestream** (`LITESTREAM_VERSION`, release package checked against its
  pinned SHA-256): continuous backup of `index.db` and `vault.db`.
- **Nightly relay export**: every event on the relay (including RSVPs and
  comments other people send, which `index.db` cannot rebuild), as
  zstd-compressed JSON lines.

The indexer and API units run `indexer/src/main.ts` (the poll service) and
`api/src/main.ts` (the API and the pages). The setup starts each one only when
the secrets are in place and its file is in the checked-out code. The API's
unit cannot see `/etc/eventindex/`: it needs no secret.

`/usr/local/bin/eventindex-admin` runs the maintainer's commands
(`indexer/src/admin.ts`) as the service user with the services' settings.

## Layout on the server

| Path | Holds |
|---|---|
| `/etc/eventindex/deploy.env` | configuration (from `config.example.env`) |
| `/etc/eventindex/index-key.nsec` | the Event Index key (secret) |
| `/etc/eventindex/bucket.env` | the bucket keys (secret) |
| `/etc/eventindex/calendar-key.secret` | the vault's master secret (secret) |
| `/etc/eventindex/eventindex.env` | settings for the indexer and the API (rendered) |
| `/opt/eventindex/app` | the code at `REPO_REF` |
| `/var/lib/eventindex/index.db`, `vault.db` | the databases |
| `/var/lib/eventindex/exports/` | the two newest relay exports |
| `/var/lib/strfry/db/` | the relay's LMDB database |
| `/var/www/eventindex/offline.html` | the page nginx shows while the API is down |
| `/usr/local/bin/eventindex-admin` | the maintainer's commands |
| `/etc/strfry.conf`, `/etc/litestream.yml` | rendered from the code |

`/etc/eventindex/` is mode 700 and every file in it mode 600, owned by
`eventindex`.

## Configuration

`config.example.env` lists every setting with its default. Copy it to
`/etc/eventindex/deploy.env` and set at least `ACME_EMAIL`, the bucket
(`BUCKET_ENDPOINT`, `BUCKET_REGION`, `BUCKET_NAME`, `BUCKET_PREFIX`) and
`REPO_REF` (a tag or commit for production). `PUBLISH_TO_GENERAL_RELAYS=0`
keeps the indexer from publishing anywhere but its own relay; with it set to
1, the relays in `GENERAL_RELAYS` and `LIST_RELAYS` get the events
`config.example.env` describes.

## Secrets

Three files, none of them in the repository or the bucket:

| File | Comes from | Contents |
|---|---|---|
| `index-key.nsec` | the operator, by hand | one line, the Event Index key as `nsec1…` |
| `bucket.env` | the operator, by hand | `BUCKET_ACCESS_KEY_ID=…` and `BUCKET_SECRET_ACCESS_KEY=…` |
| `calendar-key.secret` | `setup.sh first`, on the server | 64 hex digits |

Place the operator's files without leaving them in shell history, for example
by copying them from your own machine:

```sh
scp index-key.nsec bucket.env root@SERVER:/etc/eventindex/
```

The setup then sets their owner and mode.

**The calendar-key secret decrypts every calendar key in `vault.db`.** It is
created once, on first setup, and never again. Copy it off the server as soon
as the setup ends, and keep it in two places that are not the bucket:

```sh
scp root@SERVER:/etc/eventindex/calendar-key.secret .
```

A restored `vault.db` is useless without the secret it was created with, and
`setup.sh` refuses to create a new one where a vault already exists or on a
restore.

The bucket keys should be scoped to the one bucket. Keep the bucket's
versioning off: Litestream's retention (`BACKUP_RETENTION`) is what lets a
deleted calendar key leave the backups.

## First setup

1. Create the server (Ubuntu 24.04 LTS, SSH key login). Point the A and AAAA
   records of the three hostnames at it.
2. On the server, as root:

   ```sh
   git clone https://github.com/Event-Index/index /root/index
   install -d -m 700 /etc/eventindex
   cp /root/index/deploy/config.example.env /etc/eventindex/deploy.env
   nano /etc/eventindex/deploy.env
   ```

3. Place `index-key.nsec` and `bucket.env` in `/etc/eventindex/`.
4. Run the setup:

   ```sh
   /root/index/deploy/setup.sh first
   ```

   With a secret missing, the setup still installs everything, issues the
   certificate and starts the relay, but not the backups, the indexer or the
   API. Place the missing files and run `/root/index/deploy/setup.sh services`.

5. Copy `calendar-key.secret` off the server (Secrets).
6. Check:

   ```sh
   systemctl --no-pager status strfry eventindex-indexer eventindex-api litestream
   systemctl list-timers eventindex-relay-export.timer
   curl -sI https://eventindex.space | head -1
   curl -s -H 'Accept: application/nostr+json' https://relay.eventindex.space
   litestream databases -config /etc/litestream.yml
   ```

7. File the seed lists and watch the first polls (the poll service reads 20
   feeds every 30 seconds):

   ```sh
   cd /opt/eventindex/app
   eventindex-admin import-seeds seeds/luma/*.json seeds/meetup/*.json
   eventindex-admin status
   journalctl -u eventindex-indexer -f
   ```

Set `ACME_STAGING=1` for a trial run: Let's Encrypt's staging service has no
rate limits but issues untrusted certificates. Before going live, delete
`/etc/letsencrypt/live/eventindex` and its `renewal` and `archive` entries
(or run `certbot delete --cert-name eventindex`), set it back to 0, and run
the setup again.

## Upgrades

- **The code**: set `REPO_REF` in `deploy.env` to the new tag or commit, then
  `/opt/eventindex/app/deploy/upgrade.sh`. It checks out the code, installs its
  dependencies, installs any changed `NODE_VERSION`, `STRFRY_VERSION` or
  `LITESTREAM_VERSION`, then continues with the new code's own
  `setup.sh services`, which re-renders every config and restarts the services.
- **The system**: security updates install themselves. Reboot when
  `/var/run/reboot-required` exists; every service starts on boot.

## Backups

In the bucket, under `BUCKET_PREFIX`:

| Key | What | Kept |
|---|---|---|
| `index.db/` | Litestream replica of `index.db` (history: feeds drop past events) | snapshots for `BACKUP_RETENTION` |
| `vault.db/` | Litestream replica of `vault.db` (calendar keys, encrypted) | snapshots for `BACKUP_RETENTION` |
| `relay/relay-<time>.jsonl.zst` | nightly export of every relay event | `RELAY_EXPORT_KEEP_DAYS` |

Run an export by hand with `systemctl start eventindex-relay-export.service`
(log: `journalctl -u eventindex-relay-export`). Restore to a scratch server
from time to time; a backup that was never restored is a hope.

## Restore (same server, after losing data)

```sh
systemctl stop eventindex-indexer eventindex-api litestream
mv /var/lib/eventindex/index.db /var/lib/eventindex/index.db.lost   # and -wal, -shm, vault.db if present
/opt/eventindex/app/deploy/restore.sh
/opt/eventindex/app/deploy/setup.sh services
```

`restore.sh` restores both databases from the bucket (and checks their
integrity), then imports the newest relay export into strfry. `--skip-relay`
leaves the relay alone; `--relay-file FILE` imports a given export instead.
It never overwrites an existing database.

## Moving to a new host

1. **Prepare**: lower the TTL of the three DNS records (to 300 seconds) a day
   ahead.
2. **New server**: create it, clone the repository, write
   `/etc/eventindex/deploy.env` with the same bucket settings, and put the
   secrets back: `index-key.nsec`, `bucket.env`, and the original
   `calendar-key.secret`.
3. **Certificate**: copy `/etc/letsencrypt` from the old server
   (`tar -czf le.tgz /etc/letsencrypt`, copy, `tar -xzf le.tgz -C /`), so the
   new server has a certificate before DNS moves.
4. **Freeze the old server**:

   ```sh
   systemctl stop eventindex-indexer eventindex-api
   litestream sync -config /etc/litestream.yml
   systemctl stop litestream
   systemctl start eventindex-relay-export.service
   systemctl stop strfry
   ```

   The databases are now final in the bucket, and the newest export holds
   every relay event. To skip the bucket for the relay, copy the newest file
   from `/var/lib/eventindex/exports/` to the new server instead.
5. **Restore on the new server**:

   ```sh
   /root/index/deploy/setup.sh restore
   ```

   This installs everything, restores both databases from the bucket, imports
   the bucket's newest relay export, and starts the services. With an export
   copied by hand, pass it on: `setup.sh restore --relay-file FILE`.
6. **Switch DNS** to the new server's addresses. Check the page, the API and
   the relay by name once the old TTL has passed.
7. **Retire the old server** after a few days: stop everything, then destroy
   its disk, which holds the secrets.

The relay can also move as its LMDB files (`/var/lib/strfry/db/data.mdb`,
with strfry stopped on both sides) when both servers run the same strfry
version on the same architecture; the export is the portable form.

## Reviews and removals

Submitted feeds and remove requests wait for a maintainer:

```sh
eventindex-admin approvals                   # submissions the index approved itself
eventindex-admin undo-approval 7             # removes that calendar and keeps it out
eventindex-admin submissions                 # id, time, source, role, name, feed
eventindex-admin approve-submission 3 --city new-york
eventindex-admin reject-submission 4
eventindex-admin removals                    # id, time, whether the token was found in the feed, calendar
eventindex-admin approve-removal 2
eventindex-admin reject-removal 5
eventindex-admin remove meetup-pythonsd --message "asked by email"
eventindex-admin status
```

## Discovery and coverage

```sh
eventindex-admin import-aggregators --only nyc,la   # files those cities' Luma pages; without --only, every one in cities.json
eventindex-admin discoveries --hours 24             # what discovery filed, skipped (with what the page showed) and refused
eventindex-admin coverage                           # COVERAGE_PUBKEY's upcoming events against the index's, by city
```

The daily report is kept in `/var/lib/eventindex/coverage/<date>.txt`
(log: `journalctl -u eventindex-coverage`).

Outside relays that rate-limit or ban the index are paused for a day, then
tried again at half pace; a second refusal leaves them off:

```sh
eventindex-admin relays                                  # paused and left-off relays
eventindex-admin pause-relay wss://relay.example --hours 24
eventindex-admin resume-relay wss://relay.example
```

`--city` takes a slug from `seeds/cities.json` and gives the entry that
city's area. A request is verified once its token appears in the calendar's
feed; approve unverified ones only on other proof. The poll service carries
out an approved removal on its next tick (indexer rules § 10); it cannot be
undone, and the calendar is never indexed again.

## Logs

nginx's access log (`/var/log/nginx/access.log`) records time, host, request,
status, size and duration, and no visitor address. Its error log still names
the client of a failed request.

```sh
journalctl -u eventindex-indexer -u eventindex-api -u strfry -u litestream --since today
journalctl -u eventindex-relay-export
```
