#!/bin/sh
# Render the dashboard's nginx config from admin/nginx.conf.template (v1.37.0;
# v1.39.0 the /api proxy, CSP_MODE, reporting and the Tailscale Serve socket).
# Both images run this before nginx starts. Every value comes from the
# container's environment:
#
#   API_PROXY_ORIGIN    REQUIRED. The Worker origin nginx proxies /api to: an
#                       https origin with no port and no path (for example
#                       https://bifrost.example.com, the Worker's admin API
#                       host). The bundle calls only its own origin.
#   ADMIN_API_KEY       REQUIRED. The Worker's admin key. Written to <key-file>
#                       as the proxy's X-Admin-Key header, root-only (mode
#                       600); never in the served config, never printed.
#   CSP_MODE            enforce (the default) | report-only. Picks the page
#                       policy's header name (Content-Security-Policy or
#                       Content-Security-Policy-Report-Only); the policy text
#                       is the same in both. /api responses always get the
#                       enforced data policy.
#   CSP_REPORT_ORIGIN   Optional. The dashboard's own https origin (for example
#                       https://dashboard.example.com). Set, the page policy
#                       reports violations to <origin>/csp-report
#                       (report-uri, report-to and Reporting-Endpoints).
#                       Unset or empty, the policy has no report directives,
#                       no Reporting-Endpoints header is sent and /csp-report
#                       answers 404 (the receiver is off).
#   R2_PREVIEW_ORIGINS  Optional. The R2 custom-domain origins the dashboard
#                       previews PDFs from, separated by whitespace (the hosts
#                       in admin/src/lib/constants.ts R2_BUCKET_CUSTOM_DOMAINS).
#                       Added to object-src and frame-src. Unset or empty keeps
#                       object-src 'none' and frame-src 'self'.
#   API_PROXY_RESOLVER  Optional. The DNS resolvers nginx resolves the Worker
#                       host with, IPv4 addresses separated by whitespace.
#                       Default: 1.1.1.1 1.0.0.1.
#   DASHBOARD_HOSTNAMES Optional. The host names the browser opens the
#                       dashboard by (for example dashboard.example.com, or
#                       a single-label LAN, Docker or Kubernetes service
#                       name), separated by whitespace, besides localhost and
#                       127.0.0.1, which are always answered. A request for
#                       any other Host gets no answer (nginx 444, /health
#                       aside), so a name pointed at the dashboard's address
#                       by someone else is never served. Not needed behind
#                       Tailscale Serve, which sends `Host: localhost`. The
#                       Worker (API_PROXY_ORIGIN) must not be one of them.
#   DASHBOARD_LISTEN_ADDRESS
#                       Optional. The IPv4 address nginx listens on, port
#                       3001. Default 0.0.0.0, which Docker port publishing
#                       needs (publish it on the host's 127.0.0.1). Must be
#                       unset with DASHBOARD_TAILSCALE_SERVE=on.
#   DASHBOARD_TAILSCALE_SERVE
#                       off (the default) | on. on says Tailscale Serve, in
#                       the same container, is the dashboard's one way in (the
#                       :tailscale image sets it): nginx listens only on the
#                       Unix socket /run/bifrost/nginx.sock (no TCP port;
#                       the start script makes its root-only directory), and
#                       trusts the Tailscale-User-* identity headers and the
#                       X-Forwarded-Host that Serve sets. off: nginx listens
#                       on DASHBOARD_LISTEN_ADDRESS, ignores any
#                       Tailscale-User-* header a client sends (the identity
#                       endpoint answers unauthenticated and the /api proxy
#                       forwards none), and the cross-site check compares an
#                       Origin with the Host header, which the front door
#                       must pass through unchanged.
#
# Every origin must be a bare https origin, https://host[:port] with no path
# (case and one trailing slash are normalised). Any bad or missing value stops
# here, before either output is touched, so the container never starts with a
# missing or broken header, or with a proxy that has no key.
#
# Usage: render-nginx-conf.sh <template> <output> <key-file>
set -eu

template=$1
output=$2
key_file=$3

fail() {
  echo "render-nginx-conf: $*" >&2
  exit 1
}

# normalise_origin NAME VALUE: VALUE lower-cased without one trailing slash,
# or stop when it is not a bare https origin.
normalise_origin() {
  origin=$(printf '%s' "${2%/}" | tr 'A-Z' 'a-z')
  printf '%s\n' "$origin" |
    grep -Eq '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$' ||
    fail "$1 '$2' is not an https origin (https://host[:port], no path)"
  printf '%s' "$origin"
}

case "${CSP_MODE:-enforce}" in
  enforce) csp_header=Content-Security-Policy ;;
  report-only) csp_header=Content-Security-Policy-Report-Only ;;
  *) fail "CSP_MODE '${CSP_MODE:-}' must be enforce or report-only" ;;
esac

[ -n "${API_PROXY_ORIGIN:-}" ] || fail "API_PROXY_ORIGIN is required: the Worker origin the dashboard's /api proxy reaches"
proxy_origin=$(normalise_origin API_PROXY_ORIGIN "$API_PROXY_ORIGIN")
case "$proxy_origin" in
  *:[0-9]*) fail "API_PROXY_ORIGIN '$API_PROXY_ORIGIN' must not carry a port" ;;
esac
api_proxy_host=${proxy_origin#https://}

reporting=''
reporting_endpoints=''
receiver=off
if [ -n "${CSP_REPORT_ORIGIN:-}" ]; then
  receiver=on
  report_origin=$(normalise_origin CSP_REPORT_ORIGIN "$CSP_REPORT_ORIGIN")
  # Compared by host: a port on the report origin names the same server
  report_host=${report_origin#https://}
  report_host=${report_host%%:*}
  [ "$report_host" != "$api_proxy_host" ] || fail "API_PROXY_ORIGIN must not be the dashboard itself"
  reporting='; report-uri /csp-report; report-to csp-report'
  reporting_endpoints="csp-report=\"$report_origin/csp-report\""
fi

# The key goes into a double-quoted nginx string: printable ASCII with no
# space, and none of `"` (ends the string), `\` (escapes) or `$` (nginx would
# read a variable). The error messages never quote the key.
key=${ADMIN_API_KEY:-}
[ -n "$key" ] || fail "ADMIN_API_KEY is required: the dashboard proxy authenticates every API call with it"
[ "$(printf '%s' "$key" | tr -d '\r\n')" = "$key" ] || fail "ADMIN_API_KEY must not contain CR or LF"
printf '%s' "$key" | LC_ALL=C grep -Eq '^[[:graph:]]+$' ||
  fail "ADMIN_API_KEY must contain only printable non-space ASCII"
case "$key" in
  *'"'* | *'\'* | *'$'*) fail "ADMIN_API_KEY must not contain a double quote, backslash or dollar sign" ;;
esac

previews=''
resolvers=''
hostnames=''
# Split on whitespace without expanding a stray glob character.
set -f
for entry in ${R2_PREVIEW_ORIGINS:-}; do
  # A plain assignment, so `set -e` stops on a refused entry
  preview=$(normalise_origin 'R2_PREVIEW_ORIGINS entry' "$entry")
  previews="$previews $preview"
done
for entry in ${API_PROXY_RESOLVER:-1.1.1.1 1.0.0.1}; do
  printf '%s\n' "$entry" |
    grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' ||
    fail "API_PROXY_RESOLVER entry '$entry' is not an IPv4 address"
  resolvers="$resolvers $entry"
done
for entry in ${DASHBOARD_HOSTNAMES:-}; do
  hostname=$(printf '%s' "${entry%.}" | tr 'A-Z' 'a-z')
  printf '%s\n' "$hostname" |
    grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' ||
    fail "DASHBOARD_HOSTNAMES entry '$entry' is not a host name (DNS letters, digits, hyphens and dots; no underscore, scheme, port or wildcard)"
  # The /api proxy would call the dashboard itself
  [ "$hostname" != "$api_proxy_host" ] ||
    fail "API_PROXY_ORIGIN must not be the dashboard itself (its host is in DASHBOARD_HOSTNAMES)"
  hostnames="$hostnames $hostname"
done
set +f
[ -n "$resolvers" ] || fail "API_PROXY_RESOLVER must name at least one IPv4 address"
case "${DASHBOARD_TAILSCALE_SERVE:-off}" in
  off)
    tailscale_serve=off
    listen_address=${DASHBOARD_LISTEN_ADDRESS:-0.0.0.0}
    printf '%s\n' "$listen_address" |
      grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' ||
      fail "DASHBOARD_LISTEN_ADDRESS '$listen_address' is not an IPv4 address"
    listen="$listen_address:3001"
    ;;
  on)
    tailscale_serve=on
    [ -z "${DASHBOARD_LISTEN_ADDRESS:-}" ] ||
      fail "DASHBOARD_LISTEN_ADDRESS must be unset with DASHBOARD_TAILSCALE_SERVE=on: nginx then listens only on its Unix socket"
    listen=unix:/run/bifrost/nginx.sock
    ;;
  *) fail "DASHBOARD_TAILSCALE_SERVE '${DASHBOARD_TAILSCALE_SERVE:-}' must be on or off" ;;
esac
resolvers=${resolvers# }
if [ -n "$previews" ]; then
  object_src=${previews# }
else
  object_src="'none'"
fi

# The key file path is substituted into the config, so it is held to plain
# path characters too.
printf '%s\n' "$key_file" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail "the key file must be an absolute plain path"

# Validated values hold no sed metacharacters ('|', '&', '\'), so they
# substitute literally; the key never passes through sed. Both files are
# written to temp files that are removed on any failure, and replaced only by
# a complete render: the config last, so it never names a key file that is
# not there.
tmp="$output.tmp"
key_tmp="$key_file.tmp"
trap 'rm -f -- "$tmp" "$key_tmp"' EXIT
sed \
  -e "s|__CSP_HEADER__|$csp_header|g" \
  -e "s|__CSP_OBJECT_SRC__|$object_src|g" \
  -e "s|__CSP_PREVIEW_ORIGINS__|$previews|g" \
  -e "s|__CSP_REPORTING__|$reporting|g" \
  -e "s|__CSP_REPORTING_ENDPOINTS__|$reporting_endpoints|g" \
  -e "s|__CSP_RECEIVER__|$receiver|g" \
  -e "s|__API_PROXY_HOST__|$api_proxy_host|g" \
  -e "s|__API_PROXY_RESOLVER__|$resolvers|g" \
  -e "s|__ADMIN_KEY_INCLUDE__|$key_file|g" \
  -e "s|__DASHBOARD_HOSTNAMES__|$hostnames|g" \
  -e "s|__LISTEN__|$listen|g" \
  -e "s|__TAILSCALE_SERVE__|$tailscale_serve|g" \
  "$template" >"$tmp"
if grep -Eq '__[A-Z_]+__' "$tmp"; then
  fail "placeholder left unrendered in $output"
fi
[ "$(grep -c "add_header $csp_header \\\$bifrost_page_csp always;" "$tmp")" = 1 ] ||
  fail "the rendered config must carry exactly one $csp_header page policy header"
[ "$(grep -c "include $key_file;" "$tmp")" = 1 ] ||
  fail "the rendered config must include the admin key exactly once"

(
  umask 077
  printf 'proxy_set_header X-Admin-Key "%s";\n' "$key" >"$key_tmp"
)
chmod 600 "$key_tmp"
mv "$key_tmp" "$key_file"
mv "$tmp" "$output"
trap - EXIT
