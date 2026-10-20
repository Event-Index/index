# /etc/eventindex/: the operator places the index key and the bucket keys by
# hand; the signer secret is created here whenever it is missing.
#   index-key.nsec         the Event Index key (operator)
#   bucket.env             BUCKET_ACCESS_KEY_ID, BUCKET_SECRET_ACCESS_KEY (operator)
#   signer.secret          64 hex digits: seals signer connections, derives the intake key
#   eventindex.env         the services' settings (rendered)

log "secrets in $ETC"
chown "$SERVICE_USER:$SERVICE_USER" "$ETC"
chmod 700 "$ETC"

# Losing it costs only a reconnection by an organizer whose signer is connected.
signer="$ETC/signer.secret"
if [ ! -s "$signer" ]; then
  log "creating the signer secret"
  (umask 077 && openssl rand -hex 32 >"$signer")
fi

missing=0
for file in index-key.nsec bucket.env; do
  if [ ! -s "$ETC/$file" ]; then
    warn "$ETC/$file is missing: place it by hand (README.md, Secrets)"
    missing=1
  fi
done
if [ -s "$ETC/index-key.nsec" ] && ! grep -Eq '^nsec1[02-9ac-hj-np-z]{58}$' "$ETC/index-key.nsec"; then
  die "$ETC/index-key.nsec must hold one nsec1… line"
fi
if [ -s "$ETC/bucket.env" ]; then
  grep -q '^BUCKET_ACCESS_KEY_ID=.' "$ETC/bucket.env" && grep -q '^BUCKET_SECRET_ACCESS_KEY=.' "$ETC/bucket.env" \
    || die "$ETC/bucket.env must set BUCKET_ACCESS_KEY_ID and BUCKET_SECRET_ACCESS_KEY"
fi

render "$DEPLOY_DIR/templates/eventindex.env" "$ETC/eventindex.env" "$TEMPLATE_VARS"
for file in "$ETC"/*; do
  chown "$SERVICE_USER:$SERVICE_USER" "$file"
  chmod 600 "$file"
done
SECRETS_MISSING=$missing
