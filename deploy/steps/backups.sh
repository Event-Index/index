# The Litestream config and its unit drop-in (rendered; started by services.sh).

render "$DEPLOY_DIR/templates/litestream.yml" /etc/litestream.yml "$TEMPLATE_VARS"
chown "root:$SERVICE_USER" /etc/litestream.yml
chmod 640 /etc/litestream.yml
install -d -m 755 /etc/systemd/system/litestream.service.d
render "$DEPLOY_DIR/templates/systemd/litestream-override.conf" /etc/systemd/system/litestream.service.d/eventindex.conf "$TEMPLATE_VARS"
systemctl daemon-reload
