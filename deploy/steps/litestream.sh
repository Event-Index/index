# Litestream from the official release package, checked against its pinned
# SHA-256.

if [ "$(litestream version 2>/dev/null || true)" = "v$LITESTREAM_VERSION" ]; then
  echo "litestream $LITESTREAM_VERSION already installed"
  return 0
fi
log "litestream $LITESTREAM_VERSION"
case "$(arch)" in
  x64) file="litestream-$LITESTREAM_VERSION-linux-x86_64.deb"; sha="$LITESTREAM_SHA256_X64" ;;
  arm64) file="litestream-$LITESTREAM_VERSION-linux-arm64.deb"; sha="$LITESTREAM_SHA256_ARM64" ;;
esac
tmp="$(mktemp -d)"
fetch_verified "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/$file" "$tmp/$file" "$sha"
apt-get install -y -q "$tmp/$file"
rm -rf "$tmp"
