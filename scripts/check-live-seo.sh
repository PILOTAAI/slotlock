#!/usr/bin/env bash
# What a search engine meets on the live Slotlock hosts, after each deploy of the site
# (.github/workflows/site.yml; docs/rfc/0005-search.md, Part 4).
#
# Fails on what this repository controls: the sitemap, the pages, the Markdown twins' canonical
# headers, the not-found status. Warns on what is a Cloudflare setting of the pylota.io zone (RFC
# 0005, Phase 0), naming the setting: the HTTPS redirect, Cloudflare's managed robots.txt, and
# noindex on the dashboard and API hosts.
#
#   bash scripts/check-live-seo.sh [https://slotlock.pylota.io]
set -euo pipefail

SITE="${1:-https://slotlock.pylota.io}"
HOST="${SITE#https://}"
failures=0

fail() {
  echo "::error::$1"
  failures=$((failures + 1))
}
warn() { echo "::warning::$1"; }
ok() { echo "ok: $1"; }

# The deploy has just finished: give the edge a few tries before calling a page missing.
status() {
  local code
  for _ in 1 2 3 4 5; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" || echo 000)"
    [ "$code" = "$2" ] && break
    sleep 3
  done
  echo "$code"
}
header() { curl -sS -D - -o /dev/null --max-time 20 "$1" | tr -d '\r' | grep -i "^$2:" | head -1 || true; }

for path in / /pricing/ /mcp-server/ /booking-api/ /use-cases/car-rental/ /blog/ /docs/quickstart/; do
  code="$(status "$SITE$path" 200)"
  [ "$code" = 200 ] && ok "$path answers 200" || fail "$SITE$path answers $code, not 200"
done

code="$(status "$SITE/this-page-does-not-exist/" 404)"
[ "$code" = 404 ] && ok "an unknown path answers 404" || fail "an unknown path answers $code, not 404"

sitemap="$(curl -sS --max-time 20 "$SITE/sitemap-0.xml" || true)"
if grep -q "<loc>$SITE/pricing/</loc>" <<<"$sitemap" && grep -q '<lastmod>' <<<"$sitemap"; then
  ok "the sitemap lists the pages with lastmod"
else
  fail "$SITE/sitemap-0.xml does not list /pricing/ with a lastmod"
fi

canonical="$(header "$SITE/docs/quickstart.md" link)"
if grep -q "<$SITE/docs/quickstart/>; rel=\"canonical\"" <<<"$canonical"; then
  ok "Markdown twins name their HTML page as canonical"
else
  fail "$SITE/docs/quickstart.md has no canonical Link header (site/public/_headers): '$canonical'"
fi

image="$(header "$SITE/og/landing.png" content-type)"
grep -qi 'image/png' <<<"$image" && ok "the preview image is served" || fail "$SITE/og/landing.png is not served as a PNG"

robots="$(curl -sS --max-time 20 "$SITE/robots.txt" || true)"
grep -q "Sitemap: $SITE/sitemap-index.xml" <<<"$robots" && ok "robots.txt names the sitemap" || fail "robots.txt does not name the sitemap"
if grep -q 'Content-Signal' <<<"$robots"; then
  warn "robots.txt still carries Cloudflare's managed block (it fails Lighthouse's robots.txt audit and turns AI crawlers away). Turn off the managed robots.txt for $HOST in Cloudflare (RFC 0005, 0.4)."
else
  ok "robots.txt is the site's own"
fi

location="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "http://$HOST/" || true)"
if [[ "$location" =~ ^30[178]\ https://$HOST/ ]]; then
  ok "http:// redirects to https://"
else
  warn "http://$HOST/ answers '$location', not a redirect to https. Turn on Always Use HTTPS for the pylota.io zone in Cloudflare (RFC 0005, 0.3)."
fi

for url in https://app.slotlock.pylota.io/dashboard https://slotlock-api.pylota.io/healthz; do
  if grep -qi 'noindex' <<<"$(header "$url" x-robots-tag)"; then
    ok "$url is noindex"
  else
    warn "$url sends no X-Robots-Tag: noindex, so search engines can list it. Add a response-header Transform Rule in Cloudflare (RFC 0005, 0.6)."
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "check-live-seo: $failures failure(s)"
  exit 1
fi
echo "check-live-seo: the live site is ready for crawlers (warnings, if any, are Cloudflare settings)"
