/**
 * The closed-port probe (v1.41.0): a POSIX shell script that proves nothing
 * listens on a TCP port inside a container, run there with `docker exec -i
 * <container> sh -s` by `scripts/check-dashboard-container.mjs` against the
 * `:tailscale` image (tailscaled's userspace networking hands a tailnet
 * connection to any port of the node to `127.0.0.1:<port>`, so a TCP listener
 * there would answer the tailnet around Tailscale Serve).
 *
 * It prints {@link closedPortMarker} ONLY on specific evidence, never on the
 * absence of an error:
 *   - `/proc/net/tcp` is read without error and reads as a socket table, and
 *     so is `/proc/net/tcp6` when it exists; a `tcp6` that does not exist
 *     (IPv6 disabled in the kernel, so no IPv6 socket can listen) counts as no
 *     IPv6 listeners, a `tcp6` that exists but cannot be read does not;
 *   - neither table holds a socket in state LISTEN (`0A`) on the port;
 *   - `curl http://127.0.0.1:<port>/` is refused (curl exit 7: connection
 *     refused), not merely failed or timed out.
 * A missing curl, an unreadable table, a listener or any other curl result
 * prints no marker and exits non-zero (3: the evidence could not be read; 4:
 * curl was not refused; 5: a socket listens). `BIFROST_CLOSED_PORT` and
 * `BIFROST_PROC_NET` override the port and the `/proc/net` directory, for
 * `scripts/check-dashboard-security.test.mjs` only (`docker exec` passes no
 * host environment, and the container check requires the 3001 marker).
 */

/** The port the plain image's nginx listens on, and the `:tailscale` image's must not. */
export const DASHBOARD_TCP_PORT = 3001;

/** What the probe prints when the port is proven closed. */
export function closedPortMarker(port = DASHBOARD_TCP_PORT) {
  return `tcp-${port}-closed`;
}

export const CLOSED_PORT_PROBE = `port="\${BIFROST_CLOSED_PORT:-${DASHBOARD_TCP_PORT}}"
proc="\${BIFROST_PROC_NET:-/proc/net}"
command -v curl >/dev/null 2>&1 || { echo "closed-port probe: curl is missing" >&2; exit 3; }
tcp="$(cat "$proc/tcp")" || { echo "closed-port probe: $proc/tcp could not be read" >&2; exit 3; }
case "$tcp" in
  *local_address*) ;;
  *) echo "closed-port probe: $proc/tcp is not a socket table" >&2; exit 3 ;;
esac
if [ -e "$proc/tcp6" ]; then
  tcp6="$(cat "$proc/tcp6")" || { echo "closed-port probe: $proc/tcp6 could not be read" >&2; exit 3; }
  case "$tcp6" in
    *local_address*) ;;
    *) echo "closed-port probe: $proc/tcp6 is not a socket table" >&2; exit 3 ;;
  esac
else
  # IPv6 disabled: no tcp6 table, so no IPv6 socket listens
  tcp6=''
fi
hex="$(printf '%04X' "$port")"
listening="$(printf '%s\\n%s\\n' "$tcp" "$tcp6" |
  awk -v port="$hex" '$4 == "0A" { n = split($2, parts, ":"); if (parts[n] == port) count++ } END { print count + 0 }')"
case "$listening" in
  '' | *[!0-9]*) echo "closed-port probe: could not count listening sockets" >&2; exit 3 ;;
esac
[ "$listening" -eq 0 ] || { echo "closed-port probe: $listening socket(s) listen on TCP $port" >&2; exit 5; }
curl -s --connect-timeout 3 --max-time 5 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null
status=$?
[ "$status" -eq 7 ] || { echo "closed-port probe: curl exit $status on TCP $port, not 7 (refused)" >&2; exit 4; }
echo "tcp-$port-closed"
`;
