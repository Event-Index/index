# nginx: port 80 first (so Let's Encrypt can reach the challenge directory),
# then port 443 once the certificate exists.

stage="$1"
install -d -m 755 "$ACME_DIR"
rm -f /etc/nginx/sites-enabled/default
render "$DEPLOY_DIR/templates/nginx-http.conf" /etc/nginx/sites-available/eventindex-http.conf "$TEMPLATE_VARS"
ln -sfn /etc/nginx/sites-available/eventindex-http.conf /etc/nginx/sites-enabled/eventindex-http.conf
if [ "$stage" = tls ]; then
  render "$DEPLOY_DIR/templates/nginx-tls.conf" /etc/nginx/sites-available/eventindex-tls.conf "$TEMPLATE_VARS"
  ln -sfn /etc/nginx/sites-available/eventindex-tls.conf /etc/nginx/sites-enabled/eventindex-tls.conf
fi
nginx -t -q
systemctl enable --now nginx
systemctl reload nginx
