#!/bin/sh
set -eu

CADDY_OPEN_FILE=${SYSTEMFORGE_CADDY_OPEN_FILE:-deploy/Caddyfile.systemforge.open}
IPV4_URL=${CLOUDFLARE_IPV4_URL:-https://www.cloudflare.com/ips-v4}
IPV6_URL=${CLOUDFLARE_IPV6_URL:-https://www.cloudflare.com/ips-v6}
VERIFY_ROOT=$(mktemp -d)

cleanup() {
  rm -rf "$VERIFY_ROOT"
}
trap cleanup EXIT HUP INT TERM

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 2 \
  --retry-all-errors \
  --max-time 15 \
  --output "$VERIFY_ROOT/cloudflare-v4" \
  "$IPV4_URL"
curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 2 \
  --retry-all-errors \
  --max-time 15 \
  --output "$VERIFY_ROOT/cloudflare-v6" \
  "$IPV6_URL"

awk '
  $1 == "not" && $2 == "remote_ip" {
    for (field = 3; field <= NF; field += 1) print $field
  }
' "$CADDY_OPEN_FILE" > "$VERIFY_ROOT/configured"
awk 'index($0, ":") == 0 && NF { print }' \
  "$VERIFY_ROOT/configured" > "$VERIFY_ROOT/configured-v4"
awk 'index($0, ":") > 0 && NF { print }' \
  "$VERIFY_ROOT/configured" > "$VERIFY_ROOT/configured-v6"
awk 'NF { sub(/\r$/, ""); print }' \
  "$VERIFY_ROOT/cloudflare-v4" > "$VERIFY_ROOT/published-v4"
awk 'NF { sub(/\r$/, ""); print }' \
  "$VERIFY_ROOT/cloudflare-v6" > "$VERIFY_ROOT/published-v6"

diff -u "$VERIFY_ROOT/published-v4" "$VERIFY_ROOT/configured-v4"
diff -u "$VERIFY_ROOT/published-v6" "$VERIFY_ROOT/configured-v6"

echo "Cloudflare origin range contract passed."
