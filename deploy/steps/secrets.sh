# /etc/eventindex/: the operator places the index key and the bucket keys by
# hand; the calendar-key secret is created here on first setup only.
#   index-key.nsec         the Event Index key (operator)
#   bucket.env             BUCKET_ACCESS_KEY_ID, BUCKET_SECRET_ACCESS_KEY (operator)
#   calendar-key.secret    64 hex digits, the vault's master secret (first setup)
#   eventindex.env         the services' settings (rendered)

mode="$1"
log "secrets in $ETC"
chown "$SERVICE_USER:$SERVICE_USER" "$ETC"
chmod 700 "$ETC"

secret="$ETC/calendar-key.secret"
if [ ! -s "$secret" ]; then
  if [ "$mode" != first ]; then
    die "$secret is missing. On a restore, put back the secret this server's vault.db was created with; a new one cannot decrypt it."
  fi
  [ ! -e "$DATA_DIR/vault.db" ] || die "$DATA_DIR/vault.db exists but $secret does not; refusing to create a new secret"
  log "creating the calendar-key secret (copy it off this server now; see README.md)"
  umask 077
  openssl rand -hex 32 >"$secret"
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
