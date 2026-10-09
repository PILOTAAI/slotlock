#!/usr/bin/env bash
# Rebuild the self-hosted woff2 fonts in public/fonts from the OFL sources Pylota keeps in
# packages/ui/fonts (Google Fonts revision 23e54b51, SHA-256 recorded in that directory's
# sources.json). Needs fonttools and brotli on PATH (pip install fonttools==4.66.1 brotli==1.2.0).
#
#   scripts/subset-fonts.sh /path/to/pylota/packages/ui/fonts
#
# The output is committed, so a site build never needs the sources or fonttools.
set -euo pipefail

src="${1:?usage: subset-fonts.sh <dir holding inter.ttf, inter-tight.ttf, jetbrains-mono.ttf>}"
out="$(cd "$(dirname "$0")/.." && pwd)/public/fonts"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Basic Latin, Latin-1, Latin Extended-A, typographic punctuation, arrows and the few maths signs
# the docs use (≤ ≥ − ×). The copy itself is ASCII plus en dash, middle dot and ellipsis.
unicodes="U+0020-007E,U+00A0-017F,U+2010-2027,U+2030-203A,U+2190-2195,U+2212,U+2215,U+2260,U+2264-2265,U+00D7,U+2713,U+2717,U+25CF,U+25CB"

# Inter Tight: display headings only, regular weight.
fonttools varLib.instancer "$src/inter-tight.ttf" wght=400 -q -o "$tmp/inter-tight.ttf"
# Inter: body text and UI, 400 to 700, text optical size.
fonttools varLib.instancer "$src/inter.ttf" wght=400:700 opsz=14 -q -o "$tmp/inter.ttf"
# JetBrains Mono: code, eyebrows, timestamps; 400 to 600.
fonttools varLib.instancer "$src/jetbrains-mono.ttf" wght=400:600 -q -o "$tmp/jetbrains-mono.ttf"

for name in inter-tight inter jetbrains-mono; do
  pyftsubset "$tmp/$name.ttf" \
    --unicodes="$unicodes" \
    --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk,tnum,case,ss01,cv11,zero' \
    --flavor=woff2 \
    --no-hinting \
    --desubroutinize \
    --output-file="$out/$name.woff2"
  cp "$src/$name.ttf.OFL.txt" "$out/$name.OFL.txt"
done

ls -l "$out"
