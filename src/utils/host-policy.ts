/**
 * Outbound host policy (v1.37.2): the ONE decision on which
 * hosts the Worker may fetch for a caller-supplied URL. Both outbound
 * validators use it — the link-preview fetcher (`validateUrlForSSRF`,
 * src/utils/og-parser.ts) and the proxy target check (`validateProxyTarget`,
 * src/utils/url-validation.ts) — so a gap closed here is closed for both.
 *
 * Pass `URL.hostname`: the WHATWG URL parser has already lowercased the name,
 * put an IPv4 address in canonical dotted-quad form (so decimal, hex and
 * octal spellings arrive as a.b.c.d) and an IPv6 address in brackets.
 *
 * - **Names:** at most ONE trailing dot is stripped; a name with any empty
 *   label left (`a..b`, or a second trailing dot) is refused, since WHATWG
 *   treats `2130706433..` as a domain rather than an IPv4 address. A name
 *   whose last label is all digits or `0x…` but is not a valid IPv4 address
 *   is refused too (the WHATWG "ends in a number" rule). `localhost` and every
 *   `*.localhost`, `*.internal` and `*.local` name are refused, plus a few
 *   exact internal names. Other names are allowed and are NOT resolved: a
 *   public name whose DNS answer is private is not caught here.
 * - **IPv4:** a numeric block list of non-public ranges (BLOCKED_IPV4_CIDRS).
 * - **IPv6:** an ALLOW-list. Only global unicast 2000::/3 is allowed, minus
 *   Teredo (2001::/32), documentation (2001:db8::/32 and 3fff::/20),
 *   benchmarking (2001:2::/48), ORCHID (2001:10::/28, 2001:20::/28) and 6to4
 *   (2002::/16).
 *   Everything else — ::, ::1, IPv4-mapped and -compatible forms, NAT64,
 *   unique-local, link-local, site-local, multicast, and anything that does
 *   not parse — is refused, so no embedded IPv4 address ever needs decoding.
 */

/** Why a host was refused, for the callers' error messages. */
export type HostRefusal = 'name' | 'ipv4' | 'ipv6';

/** Exact names refused besides `localhost` and the refused suffixes. */
const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'kubernetes',
  'kubernetes.default',
  'metadata',
  'metadata.google',
  'metadata.google.internal',
]);

/** Name suffixes refused: a `.localhost`, `.internal` or `.local` name. */
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local'] as const;

/** Non-public IPv4 ranges, as CIDR. */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // "this network", including 0.0.0.0
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT; includes 100.100.100.200 (Alibaba Cloud metadata)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local; includes 169.254.169.254 and 169.254.170.2 (metadata)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation (TEST-NET-1)
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation (TEST-NET-2)
  '203.0.113.0/24', // documentation (TEST-NET-3)
  '224.0.0.0/3', // multicast, reserved and broadcast (224.0.0.0-255.255.255.255)
] as const;

/** `a.b.c.d` as an unsigned 32-bit number, or null if it is not a dotted quad. */
function ipv4ToNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** BLOCKED_IPV4_CIDRS as [first, last] numbers, computed once. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = BLOCKED_IPV4_CIDRS.map(
  cidr => {
    const [network = '', prefix = ''] = cidr.split('/');
    const first = ipv4ToNumber(network) ?? 0;
    return [first, first + 2 ** (32 - Number(prefix)) - 1] as const;
  },
);

/** Colon-separated hex groups (`""` is none), or null if any is malformed. */
function parseHexGroups(part: string): number[] | null {
  if (part === '') return [];
  const values: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

/**
 * The first three 16-bit groups of an IPv6 address (no brackets), or null when
 * it is not a plain hex IPv6 address. A dotted IPv4 tail is not accepted:
 * nothing it could form is on the allow-list.
 */
function ipv6Prefix(text: string): readonly [number, number, number] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseHexGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseHexGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  const count = head.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const groups =
    halves.length === 1 ? head : [...head, ...Array.from({ length: 8 - count }, () => 0), ...tail];
  return [groups[0] ?? 0, groups[1] ?? 0, groups[2] ?? 0];
}

/** Whether an IPv6 address is on the allow-list (global unicast, minus the exceptions). */
function isAllowedIpv6(text: string): boolean {
  const prefix = ipv6Prefix(text.toLowerCase());
  if (!prefix) return false;
  const [g0, g1, g2] = prefix;
  if (g0 < 0x2000 || g0 > 0x3fff) return false; // outside 2000::/3
  if (g0 === 0x2001) {
    if (g1 === 0x0000) return false; // Teredo 2001::/32
    if (g1 === 0x0db8) return false; // documentation 2001:db8::/32
    if (g1 === 0x0002 && g2 === 0x0000) return false; // benchmarking 2001:2::/48
    if ((g1 & 0xfff0) === 0x0010 || (g1 & 0xfff0) === 0x0020) return false; // ORCHID 2001:10::/28, 2001:20::/28
  }
  if (g0 === 0x2002) return false; // 6to4 2002::/16
  if (g0 === 0x3fff && (g1 & 0xf000) === 0x0000) return false; // documentation 3fff::/20 (RFC 9637)
  return true;
}

/**
 * `hostname` without the one trailing dot of the FQDN spelling (the root
 * label). Only one is removed: `a.b..` keeps an empty label. Shared by the
 * policy and the own-domain preview check.
 */
export function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

/**
 * Why `hostname` may not be fetched, or null when it may. `hostname` is a
 * URL's `hostname` (an IPv6 address in brackets); an unbracketed IPv6
 * address is accepted too.
 */
export function hostRefusal(hostname: string): HostRefusal | null {
  // At most one trailing dot is the root label; any other empty label below
  const host = stripTrailingDot(hostname.toLowerCase());
  if (host === '') return 'name';
  if (host.startsWith('[') || host.includes(':')) {
    const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return isAllowedIpv6(literal) ? null : 'ipv6';
  }
  const labels = host.split('.');
  if (labels.includes('')) return 'name';
  const ipv4 = ipv4ToNumber(host);
  if (ipv4 !== null) {
    return BLOCKED_IPV4_RANGES.some(([first, last]) => ipv4 >= first && ipv4 <= last)
      ? 'ipv4'
      : null;
  }
  // WHATWG "ends in a number": such a host is an IPv4 address or invalid,
  // never a name, so anything not already a canonical dotted quad is refused
  const last = labels.at(-1) ?? '';
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return 'ipv4';
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return 'name';
  }
  return null;
}

/** Whether `hostname` may not be fetched (see hostRefusal). */
export function isBlockedHost(hostname: string): boolean {
  return hostRefusal(hostname) !== null;
}
