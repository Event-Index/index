# Node.js from the official release, checked against its pinned SHA-256.

a="$(arch)"
want="v$NODE_VERSION"
if [ "$(node --version 2>/dev/null || true)" = "$want" ]; then
  echo "node $want already installed"
  return 0
fi
log "node $want"
case "$a" in
  x64) sha="$NODE_SHA256_X64" ;;
  arm64) sha="$NODE_SHA256_ARM64" ;;
esac
name="node-$want-linux-$a"
tmp="$(mktemp -d)"
fetch_verified "https://nodejs.org/dist/$want/$name.tar.xz" "$tmp/$name.tar.xz" "$sha"
tar -xJf "$tmp/$name.tar.xz" -C /opt
rm -rf "$tmp"
ln -sfn "/opt/$name" /opt/node
for bin in node npm npx; do ln -sfn "/opt/node/bin/$bin" "/usr/local/bin/$bin"; done
node --version
