#!/bin/sh
set -eu

NGINX_CONFIG=${SYSTEMFORGE_NGINX_CONFIG:-deploy/nginx.conf}

grep -Fq \
  'Cloudflare-CDN-Cache-Control "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400"' \
  "$NGINX_CONFIG"
grep -Fq \
  'Cache-Control "public, max-age=0, must-revalidate"' \
  "$NGINX_CONFIG"

if grep -Fq 's-maxage=' "$NGINX_CONFIG"; then
  echo "s-maxage disables the intended stale edge fallback." >&2
  exit 1
fi

echo "Cloudflare edge cache contract passed."
