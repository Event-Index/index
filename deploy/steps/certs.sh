# One Let's Encrypt certificate ("eventindex") for the three names, renewed by
# certbot's timer, with nginx reloaded after each renewal.

if [ -s /etc/letsencrypt/live/eventindex/fullchain.pem ]; then
  echo "certificate already present"
else
  log "certificate for $DOMAIN, $API_HOST, $RELAY_HOST"
  staging=()
  [ "${ACME_STAGING:-0}" = 1 ] && staging=(--staging)
  certbot certonly --webroot -w "$ACME_DIR" --cert-name eventindex \
    -d "$DOMAIN" -d "$API_HOST" -d "$RELAY_HOST" \
    --email "$ACME_EMAIL" --agree-tos --non-interactive "${staging[@]}"
fi
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
systemctl enable --now certbot.timer
