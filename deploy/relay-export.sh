#!/usr/bin/env bash
# Nightly: every event on the relay (including RSVPs and comments other people
# sent, which index.db cannot rebuild) as zstd-compressed JSON lines, uploaded
# to the bucket; exports older than RELAY_EXPORT_KEEP_DAYS are removed.
# Runs as the service user from eventindex-relay-export.service.

. "$(dirname "$0")/lib.sh"
load_config
: "${BUCKET_ACCESS_KEY_ID:?bucket keys are not in the environment}" "${BUCKET_SECRET_ACCESS_KEY:?}"

name="relay-$(date -u +%Y-%m-%dT%H%M%SZ).jsonl.zst"
out="$DATA_DIR/exports/$name"
/usr/local/bin/strfry --config=/etc/strfry.conf export | zstd -q -T0 -10 -o "$out"
[ -s "$out" ] || die "export is empty"

export RCLONE_CONFIG_BUCKET_TYPE=s3 RCLONE_CONFIG_BUCKET_PROVIDER=Other RCLONE_CONFIG_BUCKET_NO_CHECK_BUCKET=true \
  RCLONE_CONFIG_BUCKET_ENDPOINT="$BUCKET_ENDPOINT" RCLONE_CONFIG_BUCKET_REGION="$BUCKET_REGION" \
  RCLONE_CONFIG_BUCKET_ACCESS_KEY_ID="$BUCKET_ACCESS_KEY_ID" RCLONE_CONFIG_BUCKET_SECRET_ACCESS_KEY="$BUCKET_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG=/dev/null XDG_CACHE_HOME="$DATA_DIR/exports/.cache"
rclone copyto "$out" "bucket:$BUCKET_NAME/$BUCKET_PREFIX/relay/$name"
rclone delete "bucket:$BUCKET_NAME/$BUCKET_PREFIX/relay/" --min-age "${RELAY_EXPORT_KEEP_DAYS:-30}d" --include 'relay-*.jsonl.zst'

# Keep the two newest exports on disk.
ls -1t "$DATA_DIR"/exports/relay-*.jsonl.zst | tail -n +3 | xargs -r rm -f
echo "exported $name ($(du -h "$out" | cut -f1))"
