/**
 * The shared outbound host policy (v1.37.2), through BOTH
 * validators that use it: the link-preview fetcher (validateUrlForSSRF) and
 * the proxy target check (validateProxyTarget / isPrivateIP). Every row runs
 * through both, so the two cannot drift apart again.
 */
import { describe, expect, it } from 'vitest';
import { hostRefusal } from '../../src/utils/host-policy';
import { SSRFBlockedError, validateUrlForSSRF } from '../../src/utils/og-parser';
import { isPrivateIP, validateProxyTarget } from '../../src/utils/url-validation';

/** [label, URL, the refusal the policy gives] */
const BLOCKED: ReadonlyArray<readonly [string, string, 'name' | 'ipv4' | 'ipv6']> = [
  // Names (trailing dots stripped first)
  ['localhost', 'http://localhost/', 'name'],
  ['localhost with a trailing dot', 'http://localhost./', 'name'],
  ['localhost with two trailing dots', 'http://localhost../', 'name'],
  ['upper-case localhost', 'http://LOCALHOST/', 'name'],
  ['a *.localhost name', 'http://app.localhost/', 'name'],
  ['a *.internal name', 'http://db.corp.internal/', 'name'],
  ['metadata.google.internal with a trailing dot', 'http://metadata.google.internal./', 'name'],
  ['a *.local name', 'http://printer.local/', 'name'],
  ['localhost.localdomain', 'http://localhost.localdomain/', 'name'],
  ['ip6-localhost', 'http://ip6-localhost/', 'name'],
  ['kubernetes.default', 'http://kubernetes.default/', 'name'],
  ['metadata', 'http://metadata/', 'name'],
  // IPv4
  ['0.0.0.0', 'http://0.0.0.0/', 'ipv4'],
  ['10.0.0.0/8', 'http://10.1.2.3/', 'ipv4'],
  ['100.64.0.0/10 low', 'http://100.64.0.1/', 'ipv4'],
  ['100.64.0.0/10 high', 'http://100.127.255.254/', 'ipv4'],
  ['Alibaba Cloud metadata', 'http://100.100.100.200/', 'ipv4'],
  ['loopback', 'http://127.0.0.1/', 'ipv4'],
  ['loopback with a trailing dot', 'http://127.0.0.1./', 'ipv4'],
  ['loopback as an integer', 'http://2130706433/', 'ipv4'],
  ['AWS/GCP/Azure metadata', 'http://169.254.169.254/', 'ipv4'],
  ['metadata in hex', 'http://0xa9fea9fe/', 'ipv4'],
  ['AWS ECS metadata', 'http://169.254.170.2/', 'ipv4'],
  ['172.16.0.0/12', 'http://172.31.255.255/', 'ipv4'],
  ['192.0.0.0/24', 'http://192.0.0.8/', 'ipv4'],
  ['192.0.2.0/24', 'http://192.0.2.1/', 'ipv4'],
  ['192.88.99.0/24', 'http://192.88.99.1/', 'ipv4'],
  ['192.168.0.0/16', 'http://192.168.1.1/', 'ipv4'],
  ['198.18.0.0/15 low', 'http://198.18.0.1/', 'ipv4'],
  ['198.18.0.0/15 high', 'http://198.19.255.254/', 'ipv4'],
  ['198.51.100.0/24', 'http://198.51.100.7/', 'ipv4'],
  ['203.0.113.0/24', 'http://203.0.113.9/', 'ipv4'],
  ['multicast', 'http://224.0.0.1/', 'ipv4'],
  ['reserved', 'http://240.0.0.1/', 'ipv4'],
  ['broadcast', 'http://255.255.255.255/', 'ipv4'],
  // IPv6: only global unicast 2000::/3 is allowed
  ['::', 'http://[::]/', 'ipv6'],
  [':: spelt out', 'http://[0:0:0:0:0:0:0:0]/', 'ipv6'],
  ['::1', 'http://[::1]/', 'ipv6'],
  ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/', 'ipv6'],
  ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/', 'ipv6'],
  ['IPv4-mapped PUBLIC address', 'http://[::ffff:8.8.8.8]/', 'ipv6'],
  ['::ffff:0:0/96 in hex', 'http://[::ffff:7f00:1]/', 'ipv6'],
  ['IPv4-compatible', 'http://[::127.0.0.1]/', 'ipv6'],
  ['IPv4-compatible PUBLIC address', 'http://[::8.8.8.8]/', 'ipv6'],
  ['NAT64 64:ff9b::/96', 'http://[64:ff9b::7f00:1]/', 'ipv6'],
  ['NAT64 64:ff9b:1::/48', 'http://[64:ff9b:1::a9fe:a9fe]/', 'ipv6'],
  ['Teredo 2001::/32', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'ipv6'],
  ['documentation 2001:db8::/32', 'http://[2001:db8::1]/', 'ipv6'],
  ['6to4 2002::/16', 'http://[2002:7f00:1::1]/', 'ipv6'],
  ['unique-local fc00::/7', 'http://[fc00::1]/', 'ipv6'],
  ['unique-local fd00::', 'http://[fd12:3456::1]/', 'ipv6'],
  ['link-local fe80::/10', 'http://[fe80::1]/', 'ipv6'],
  ['site-local fec0::/10', 'http://[fec0::1]/', 'ipv6'],
  ['multicast ff00::/8', 'http://[ff02::1]/', 'ipv6'],
  ['outside 2000::/3 (4000::)', 'http://[4000::1]/', 'ipv6'],
  ['outside 2000::/3 (100::)', 'http://[100::1]/', 'ipv6'],
  // Special-use blocks inside 2000::/3, each at both edges
  ['documentation 3fff::/20 low', 'http://[3fff::]/', 'ipv6'],
  ['documentation 3fff::/20 high', 'http://[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]/', 'ipv6'],
  ['benchmarking 2001:2::/48 low', 'http://[2001:2::]/', 'ipv6'],
  ['benchmarking 2001:2::/48 high', 'http://[2001:2:0:ffff:ffff:ffff:ffff:ffff]/', 'ipv6'],
  ['ORCHID 2001:10::/28 low', 'http://[2001:10::]/', 'ipv6'],
  ['ORCHID 2001:10::/28 high', 'http://[2001:1f:ffff:ffff:ffff:ffff:ffff:ffff]/', 'ipv6'],
  ['ORCHIDv2 2001:20::/28 low', 'http://[2001:20::]/', 'ipv6'],
  ['ORCHIDv2 2001:20::/28 high', 'http://[2001:2f:ffff:ffff:ffff:ffff:ffff:ffff]/', 'ipv6'],
  // Numeric hosts with two trailing dots are domains to WHATWG,
  // so they no longer become IPv4 addresses; an empty label refuses them
  ['an integer host with two trailing dots', 'http://2130706433../', 'name'],
  ['a hex/decimal host with two trailing dots', 'http://0x7f.1../', 'name'],
  ['an octal dotted host with two trailing dots', 'http://0177.0.0.1../', 'name'],
  ['a hex integer host with two trailing dots', 'http://0x7f000001../', 'name'],
  ['a three-part metadata host with two trailing dots', 'http://169.254.43518../', 'name'],
  ['percent-encoded trailing dots', 'http://2130706433%2e%2e/', 'name'],
  [
    'fullwidth digits and ideographic full stops',
    'http://\uFF12\uFF11\uFF13\uFF10\uFF17\uFF10\uFF16\uFF14\uFF13\uFF13\u3002\u3002/',
    'name',
  ],
  ['a name with two trailing dots', 'http://example.com../', 'name'],
];

/** Public controls both validators must let through. */
const ALLOWED: readonly string[] = [
  'https://example.com/',
  'https://example.com./',
  'https://a.b.example.com/',
  'https://api.github.com/x',
  'http://8.8.8.8/',
  'http://100.63.255.255/',
  'http://100.128.0.1/',
  'http://172.32.0.1/',
  'http://198.17.255.255/',
  'http://198.20.0.1/',
  'http://223.255.255.255/',
  'http://[2606:4700:4700::1111]/',
  'http://[2001:4860:4860::8888]/',
  'http://[2a00:1450:4001::1]/',
  // Just outside each special-use block inside 2000::/3
  'http://[3ffe:ffff::1]/',
  'http://[3fff:1000::1]/',
  'http://[2001:2:1::1]/',
  'http://[2001:3::1]/',
  'http://[2001:f:ffff::1]/',
  'http://[2001:30::1]/',
  'https://mylocal.com/',
  'https://internal.example.com/',
];

describe('shared outbound host policy', () => {
  it.each(BLOCKED)('refuses %s in both validators', (_label, url, refusal) => {
    const { hostname } = new URL(url);
    expect(hostRefusal(hostname)).toBe(refusal);
    expect(() => validateUrlForSSRF(url)).toThrow(SSRFBlockedError);
    expect(validateProxyTarget(url).valid).toBe(false);
    expect(isPrivateIP(hostname)).toBe(true);
  });

  it.each(ALLOWED)('allows %s in both validators', url => {
    const { hostname } = new URL(url);
    expect(hostRefusal(hostname)).toBeNull();
    expect(validateUrlForSSRF(url).href).toBe(new URL(url).href);
    expect(validateProxyTarget(url).valid).toBe(true);
    expect(isPrivateIP(hostname)).toBe(false);
  });

  it('refuses unbracketed and unparseable IPv6 literals', () => {
    const hosts = ['::1', '2606:4700::1:2:3:4:5:6:7', '2001:4860::zz', '1:2:3:4:5:6:7', ':'];
    expect(hosts.map(host => [host, hostRefusal(host)])).toEqual(hosts.map(host => [host, 'ipv6']));
    // A dotted tail is never on the allow-list
    expect(hostRefusal('2001:4860::8.8.8.8')).toBe('ipv6');
    // A well-formed public one passes unbracketed too
    expect(hostRefusal('2606:4700:4700::1111')).toBeNull();
  });

  it('refuses a host that ends in a number but is not a canonical IPv4 address', () => {
    // What the WHATWG parser would have read as IPv4 (or refused), passed raw
    const hosts = ['2130706433', '0x7f.1', '0177.0.0.1', '1.2.3.4.5', '0x', 'a.0x7f', 'a.123'];
    expect(hosts.map(host => [host, hostRefusal(host)])).toEqual(hosts.map(host => [host, 'ipv4']));
    // A name whose last label merely contains digits is a name
    expect(hostRefusal('a.b2')).toBeNull();
    expect(hostRefusal('x.0xg')).toBeNull();
    // One trailing dot is the root label; two leave an empty label
    expect(hostRefusal('8.8.8.8.')).toBeNull();
    expect(hostRefusal('8.8.8.8..')).toBe('name');
    expect(hostRefusal('a..b')).toBe('name');
  });

  it('refuses an empty host', () => {
    expect(hostRefusal('')).toBe('name');
    expect(hostRefusal('.')).toBe('name');
  });

  it('names the refusal in each validator', () => {
    expect(() => validateUrlForSSRF('http://localhost/')).toThrow('Blocked hostname: localhost');
    expect(() => validateUrlForSSRF('http://10.0.0.1/')).toThrow('Blocked private IP: 10.0.0.1');
    expect(() => validateUrlForSSRF('http://[::1]/')).toThrow('Blocked IPv6 address: [::1]');
    expect(validateProxyTarget('http://[::1]/').error).toBe(
      'Cannot proxy to private/internal address: [::1]',
    );
  });
});
