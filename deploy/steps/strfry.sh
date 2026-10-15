# strfry built from source at its pinned release commit, configured from the
# repository's relay/strfry.conf.

src=/usr/local/src/strfry
if [ -x /usr/local/bin/strfry ] && [ "$(cat /usr/local/src/strfry.commit 2>/dev/null || true)" = "$STRFRY_COMMIT" ]; then
  echo "strfry $STRFRY_VERSION already built"
else
  log "strfry $STRFRY_VERSION"
  if [ ! -d "$src/.git" ]; then
    git clone https://github.com/hoytech/strfry "$src"
  fi
  git -C "$src" fetch --tags --quiet
  git -C "$src" checkout --quiet "$STRFRY_VERSION"
  [ "$(git -C "$src" rev-parse HEAD)" = "$STRFRY_COMMIT" ] || die "strfry tag $STRFRY_VERSION is not commit $STRFRY_COMMIT"
  git -C "$src" submodule update --init --quiet
  make -C "$src" setup-golpe
  make -C "$src" -j"$(nproc)"
  install -m 755 "$src/strfry" /usr/local/bin/strfry
  echo "$STRFRY_COMMIT" >/usr/local/src/strfry.commit
fi
install -m 644 "$APP_DIR/relay/strfry.conf" /etc/strfry.conf
