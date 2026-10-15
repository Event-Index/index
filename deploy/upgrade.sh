#!/usr/bin/env bash
# Moves the server to the REPO_REF in /etc/eventindex/deploy.env: the code and
# its dependencies, then the rendered configs, then restarts. A changed
# NODE_VERSION, STRFRY_VERSION or LITESTREAM_VERSION is installed too.
#
#   sudo /opt/eventindex/app/deploy/upgrade.sh

. "$(dirname "$0")/lib.sh"
require_root "$@"
load_config

. "$DEPLOY_DIR/steps/node.sh"
. "$DEPLOY_DIR/steps/app.sh"
. "$DEPLOY_DIR/steps/strfry.sh"
. "$DEPLOY_DIR/steps/litestream.sh"
# Continue with the deploy scripts of the code just checked out.
exec "$APP_DIR/deploy/setup.sh" services
