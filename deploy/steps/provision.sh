# The base system: packages, service user, firewall, automatic security
# updates, swap.

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl git gettext-base xz-utils zstd rclone sqlite3 \
  build-essential python3 pkg-config \
  libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
  libyaml-perl libtemplate-perl libregexp-grammars-perl \
  nginx certbot ufw unattended-upgrades

log "service user $SERVICE_USER"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /opt/eventindex --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR" "$DATA_DIR/exports" /var/lib/strfry "$RELAY_DB_DIR"

log "firewall: 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "automatic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
systemctl enable --now unattended-upgrades

log "swap"
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness=10' >/etc/sysctl.d/90-eventindex-swap.conf
  sysctl -q -p /etc/sysctl.d/90-eventindex-swap.conf
else
  echo "swap already present"
fi
