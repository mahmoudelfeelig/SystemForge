#!/bin/sh
set -eu

NGINX_CONFIG=${SYSTEMFORGE_NGINX_CONFIG:-deploy/nginx.conf}

grep -Fq \
  'Cloudflare-CDN-Cache-Control "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400"' \
  "$NGINX_CONFIG"
grep -Fq \
  'Cache-Control "public, max-age=0, must-revalidate, no-transform"' \
  "$NGINX_CONFIG"
grep -Fq 'location ~ ^/(lab|custom|interview|replay|decisions)$ {' "$NGINX_CONFIG"
grep -Fq 'error_page 404 =404 /index.html;' "$NGINX_CONFIG"
grep -Fq \
  'add_header Cache-Control "public, max-age=31536000, immutable";' \
  "$NGINX_CONFIG"

if grep -Fq \
  'Cache-Control "public, max-age=31536000, immutable" always' \
  "$NGINX_CONFIG"; then
  echo "Immutable caching must not be attached to missing asset responses." >&2
  exit 1
fi

if grep -Fq 's-maxage=' "$NGINX_CONFIG"; then
  echo "s-maxage disables the intended stale edge fallback." >&2
  exit 1
fi

if grep -Fq 'Cache-Control "public, max-age=0, must-revalidate" always' "$NGINX_CONFIG"; then
  echo "HTML responses must opt out of edge script injection with no-transform." >&2
  exit 1
fi

echo "Static response cache contract passed."
