#!/usr/bin/env bash
# Restores index.db and vault.db from the bucket, and the relay's events from
# the newest nightly export (or from a file).
#
#   sudo deploy/restore.sh                          everything from the bucket
#   sudo deploy/restore.sh --relay-file FILE        the relay from FILE (.jsonl or .jsonl.zst)
#   sudo deploy/restore.sh --skip-relay             the databases only
#
# Refuses to overwrite: move an existing index.db or vault.db aside first.
# The calendar-key secret must be the one vault.db was created with.

. "$(dirname "$0")/lib.sh"
require_root "$@"
load_config

relay_file=""
skip_relay=0
while [ $# -gt 0 ]; do
  case "$1" in
    --relay-file) relay_file="${2:-}"; shift 2 ;;
    --skip-relay) skip_relay=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done

[ -s "$ETC/calendar-key.secret" ] || die "$ETC/calendar-key.secret is missing: put back the original secret first"
[ -s "$ETC/bucket.env" ] || die "$ETC/bucket.env is missing"
set -a
. "$ETC/bucket.env"
set +a

systemctl stop eventindex-indexer.service eventindex-api.service litestream.service 2>/dev/null || true

for db in index.db vault.db; do
  [ ! -e "$DATA_DIR/$db" ] || die "$DATA_DIR/$db exists; move it aside to restore over it"
  log "restoring $db"
  as_service env BUCKET_ACCESS_KEY_ID="$BUCKET_ACCESS_KEY_ID" BUCKET_SECRET_ACCESS_KEY="$BUCKET_SECRET_ACCESS_KEY" \
    litestream restore -config /etc/litestream.yml "$DATA_DIR/$db"
  as_service sqlite3 "$DATA_DIR/$db" 'PRAGMA integrity_check;' | grep -qx ok || die "$db failed its integrity check"
done

if [ "$skip_relay" = 0 ]; then
  export RCLONE_CONFIG_BUCKET_TYPE=s3 RCLONE_CONFIG_BUCKET_PROVIDER=Other \
    RCLONE_CONFIG_BUCKET_ENDPOINT="$BUCKET_ENDPOINT" RCLONE_CONFIG_BUCKET_REGION="$BUCKET_REGION" \
    RCLONE_CONFIG_BUCKET_ACCESS_KEY_ID="$BUCKET_ACCESS_KEY_ID" RCLONE_CONFIG_BUCKET_SECRET_ACCESS_KEY="$BUCKET_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG=/dev/null XDG_CACHE_HOME="$DATA_DIR/exports/.cache"
  if [ -z "$relay_file" ]; then
    latest="$(rclone lsf "bucket:$BUCKET_NAME/$BUCKET_PREFIX/relay/" --include 'relay-*.jsonl.zst' | sort | tail -n 1)"
    [ -n "$latest" ] || die "no relay export in bucket:$BUCKET_NAME/$BUCKET_PREFIX/relay/"
    relay_file="$DATA_DIR/exports/$latest"
    rclone copyto "bucket:$BUCKET_NAME/$BUCKET_PREFIX/relay/$latest" "$relay_file"
    chown "$SERVICE_USER:$SERVICE_USER" "$relay_file"
  fi
  [ -s "$relay_file" ] || die "$relay_file is empty or missing"
  log "importing relay events from $relay_file"
  systemctl stop strfry.service 2>/dev/null || true
  case "$relay_file" in
    *.zst) zstd -dc "$relay_file" ;;
    *) cat "$relay_file" ;;
  esac | as_service /usr/local/bin/strfry --config=/etc/strfry.conf import
  systemctl start strfry.service
fi
log "restore done; start the services with: sudo deploy/setup.sh services"
