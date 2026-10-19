# Shared by the deploy scripts. Source it; do not run it.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/eventindex
CONFIG="$ETC/deploy.env"
SERVICE_USER=eventindex
APP_DIR=/opt/eventindex/app
DATA_DIR=/var/lib/eventindex
RELAY_DB_DIR=/var/lib/strfry/db
SITE_DIR=/var/www/eventindex
ACME_DIR=/var/www/letsencrypt

log() { printf '\033[1m== %s\033[0m\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 $*)"
}

load_config() {
  [ -f "$CONFIG" ] || die "$CONFIG is missing: copy deploy/config.example.env there and edit it"
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
  local name
  for name in DOMAIN API_HOST RELAY_HOST ACME_EMAIL REPO_URL REPO_REF NODE_VERSION STRFRY_VERSION STRFRY_COMMIT \
    LITESTREAM_VERSION BUCKET_ENDPOINT BUCKET_REGION BUCKET_NAME BUCKET_PREFIX BACKUP_RETENTION API_PORT RELAY_PORT; do
    [ -n "${!name:-}" ] || die "$name is not set in $CONFIG"
  done
}

# x64 or arm64, as release files name it.
arch() {
  case "$(uname -m)" in
    x86_64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
}

# Downloads a file and checks its SHA-256.
fetch_verified() {
  local url="$1" out="$2" sha="$3"
  curl -fsSL --retry 3 -o "$out" "$url"
  echo "$sha  $out" | sha256sum -c --quiet - || die "checksum mismatch for $url"
}

# Renders a template, substituting only the listed variables so nginx's own
# $variables survive.
render() {
  local template="$1" out="$2" vars="$3"
  envsubst "$vars" <"$template" >"$out.tmp"
  mv "$out.tmp" "$out"
}

TEMPLATE_VARS='${DOMAIN} ${API_HOST} ${RELAY_HOST} ${API_PORT} ${RELAY_PORT} ${SERVICE_USER} ${APP_DIR} ${DATA_DIR} ${RELAY_DB_DIR} ${SITE_DIR} ${ACME_DIR} ${ETC} ${BUCKET_ENDPOINT} ${BUCKET_REGION} ${BUCKET_NAME} ${BUCKET_PREFIX} ${BACKUP_RETENTION} ${PUBLISH_TO_GENERAL_RELAYS} ${PUBLISH_DIRECTORY_OUTSIDE} ${DIRECTORY_HEADER} ${GENERAL_RELAYS} ${LIST_RELAYS} ${SEARCH_RELAYS} ${PROFILE_RELAYS} ${DISCOVERY_PER_RUN} ${DISCOVERY_PER_DAY} ${FOLLOW_CAP} ${COVERAGE_PUBKEY} ${COVERAGE_RELAY} ${RELAY_HOSTS_CLAIMANTS} ${CALENDAR_KEYS_PAUSED} ${EVENT_ITEMS} ${EVENTS_HEADER} ${EVENT_ITEMS_MAX} ${EVENT_ITEMS_CALENDARS} ${INGEST_NOSTR} ${INGEST_RELAYS} ${INGEST_SEARCH_RELAYS} ${PUBLISH_NOSTR_ENTRIES_OUTSIDE}'
export SERVICE_USER APP_DIR DATA_DIR RELAY_DB_DIR SITE_DIR ACME_DIR ETC

as_service() {
  runuser -u "$SERVICE_USER" -- "$@"
}
