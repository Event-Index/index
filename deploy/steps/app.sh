# The Event Index code at REPO_REF, with production dependencies.

log "app at $REPO_REF"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$(dirname "$APP_DIR")"
if [ ! -d "$APP_DIR/.git" ]; then
  as_service git clone --quiet "$REPO_URL" "$APP_DIR"
fi
as_service git -C "$APP_DIR" fetch --quiet --tags origin
# A branch name runs the branch as fetched; a tag or a commit runs as given.
if as_service git -C "$APP_DIR" rev-parse --verify --quiet "origin/$REPO_REF" >/dev/null; then
  as_service git -C "$APP_DIR" checkout --quiet --detach "origin/$REPO_REF"
else
  as_service git -C "$APP_DIR" checkout --quiet --detach "$REPO_REF"
fi
as_service git -C "$APP_DIR" log -1 --format='running %h %s'
(cd "$APP_DIR" && as_service env HOME=/opt/eventindex npm ci --omit=dev --no-audit --no-fund --loglevel=error)
