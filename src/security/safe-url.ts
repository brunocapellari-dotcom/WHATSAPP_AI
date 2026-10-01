import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const ipv4Blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) ipv4Blocked.addSubnet(network, prefix, 'ipv4');

const ipv6Blocked = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) ipv6Blocked.addSubnet(network, prefix, 'ipv6');

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith('::ffff:')) return null;
  const suffix = normalized.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2) return null;
  const hi = Number.parseInt(parts[0] ?? '', 16);
  const lo = Number.parseInt(parts[1] ?? '', 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isBlockedNetworkAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress);
  const family = isIP(address);
  if (family === 4) return ipv4Blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = mappedIpv4(address);
    if (mapped) return ipv4Blocked.check(mapped, 'ipv4');
    return ipv6Blocked.check(address, 'ipv6');
  }
  return true;
}

export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  if (url.username || url.password) throw new Error('url_credentials_forbidden');
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('private_host_forbidden');

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('host_resolution_failed');

  for (const { address } of addresses) {
    if (isBlockedNetworkAddress(address)) throw new Error('private_host_forbidden');
  }
  return url;
}
