#!/usr/bin/env bash
# Sets up an Event Index server on Ubuntu 24.04. Idempotent: safe to run again.
#
#   sudo deploy/setup.sh first      a new server with new data
#   sudo deploy/setup.sh restore    a new server, data restored from the bucket
#                                   (restore.sh options may follow, e.g. --relay-file FILE)
#   sudo deploy/setup.sh services   re-render the configs and (re)start services
#
# Before running: /etc/eventindex/deploy.env (from deploy/config.example.env),
# DNS for the three hostnames pointing here, and for `restore` the secrets put
# back (README.md).

. "$(dirname "$0")/lib.sh"
require_root "$@"
mode="${1:-}"
shift || true
case "$mode" in
  first | restore | services) ;;
  *) die "usage: setup.sh first|restore|services" ;;
esac
install -d -m 700 "$ETC"
load_config

if [ "$mode" != services ]; then
  . "$DEPLOY_DIR/steps/provision.sh"
  . "$DEPLOY_DIR/steps/node.sh"
  . "$DEPLOY_DIR/steps/app.sh"
  . "$DEPLOY_DIR/steps/strfry.sh"
  . "$DEPLOY_DIR/steps/litestream.sh"
fi
. "$DEPLOY_DIR/steps/secrets.sh" "$mode"
. "$DEPLOY_DIR/steps/backups.sh"
if [ "$mode" != services ]; then
  . "$DEPLOY_DIR/steps/nginx.sh" http
  . "$DEPLOY_DIR/steps/certs.sh"
fi
. "$DEPLOY_DIR/steps/nginx.sh" tls
if [ "$mode" = restore ]; then
  [ "$SECRETS_MISSING" = 0 ] || die "restore needs every secret in $ETC (README.md, Secrets)"
  "$DEPLOY_DIR/restore.sh" "$@"
fi
. "$DEPLOY_DIR/steps/services.sh"

log "done"
systemctl --no-pager --plain list-units 'eventindex-*' strfry.service litestream.service nginx.service || true
