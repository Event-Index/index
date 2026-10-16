# systemd units and the Litestream config. The relay, backups and the nightly
# export always run. The indexer and the API start only once the secrets are
# in place and their entry points exist in the checked-out code.

log "services"
# The page nginx shows while the API is down, and the maintainer's commands.
install -d -m 755 "$SITE_DIR"
install -m 644 "$DEPLOY_DIR/site/offline.html" "$SITE_DIR/offline.html"
rm -f "$SITE_DIR/index.html"
render "$DEPLOY_DIR/templates/eventindex-admin" /usr/local/bin/eventindex-admin "$TEMPLATE_VARS"
chmod 755 /usr/local/bin/eventindex-admin
for unit in strfry.service eventindex-indexer.service eventindex-api.service eventindex-relay-export.service eventindex-relay-export.timer \
  eventindex-coverage.service eventindex-coverage.timer; do
  render "$DEPLOY_DIR/templates/systemd/$unit" "/etc/systemd/system/$unit" "$TEMPLATE_VARS"
done
systemctl daemon-reload

# Litestream needs the databases to exist; the code creates their tables.
for db in index.db vault.db; do
  [ -e "$DATA_DIR/$db" ] || as_service sqlite3 "$DATA_DIR/$db" 'PRAGMA journal_mode=WAL;' >/dev/null
done

# The relay's config and write policy come with the code: restart it so a
# new version of either is in use.
install -m 644 "$APP_DIR/relay/strfry.conf" /etc/strfry.conf
systemctl enable strfry.service
systemctl restart strfry.service
if [ "${SECRETS_MISSING:-1}" = 0 ]; then
  systemctl enable litestream.service eventindex-relay-export.timer
  systemctl restart litestream.service
  systemctl start eventindex-relay-export.timer
else
  warn "backups not started: place the missing secrets, then run: sudo deploy/setup.sh services"
fi

for name in indexer api; do
  unit="eventindex-$name.service"
  entry="$APP_DIR/$name/src/main.ts"
  if [ "${SECRETS_MISSING:-1}" != 0 ]; then
    warn "$unit not started: secrets missing"
  elif [ ! -f "$entry" ]; then
    warn "$unit not started: $entry is not in this version of the code"
    systemctl disable "$unit" >/dev/null 2>&1 || true
  else
    systemctl enable "$unit"
    systemctl restart "$unit"
  fi
done

# The daily coverage report runs only while a publisher to compare with is set.
if [ -n "${COVERAGE_PUBKEY:-}" ] && [ "${SECRETS_MISSING:-1}" = 0 ]; then
  systemctl enable --now eventindex-coverage.timer
else
  systemctl disable --now eventindex-coverage.timer >/dev/null 2>&1 || true
fi
