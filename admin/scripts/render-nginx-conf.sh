#!/bin/sh
# Render the dashboard's nginx config from admin/nginx.conf.template (v1.37.0).
#
# R2_PREVIEW_ORIGINS lists the R2 custom-domain origins the dashboard previews
# PDFs from, separated by spaces (e.g. "https://files.example.com
# https://assets.example.com"). They are added to the CSP's object-src and
# frame-src. Unset or empty keeps object-src 'none' and frame-src 'self'.
#
# Each entry must be a bare https origin, https://host[:port], with no path
# (case and one trailing slash are normalised). Anything else stops the
# container instead of reaching the CSP header.
#
# Usage: render-nginx-conf.sh <template> <output>
set -eu

template=$1
output=$2

origins=''
# Split on whitespace without expanding a stray glob character.
set -f
for entry in ${R2_PREVIEW_ORIGINS:-}; do
  origin=$(printf '%s' "${entry%/}" | tr 'A-Z' 'a-z')
  if ! printf '%s\n' "$origin" |
    grep -Eq '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'; then
    echo "render-nginx-conf: R2_PREVIEW_ORIGINS entry '$entry' is not an https origin (https://host[:port], no path)" >&2
    exit 1
  fi
  origins="$origins $origin"
done
set +f

if [ -n "$origins" ]; then
  object_src=${origins# }
else
  object_src="'none'"
fi
frame_src="'self'$origins"

# Validated origins hold no sed metacharacters, so they substitute literally.
tmp="$output.tmp"
sed -e "s|__CSP_OBJECT_SRC__|$object_src|g" -e "s|__CSP_FRAME_SRC__|$frame_src|g" "$template" >"$tmp"
if grep -q '__CSP_' "$tmp"; then
  echo "render-nginx-conf: placeholder left unrendered in $output" >&2
  rm -f "$tmp"
  exit 1
fi
mv "$tmp" "$output"
