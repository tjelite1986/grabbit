'use strict';

// SSRF guard. Every URL that reaches grabbit is attacker-shaped input: the
// public UI is only password-gated, and grabbit sits on the same Docker
// network as traefik, portainer and elite-v2. Without this, a submitted URL
// (or a redirect from a public one) can make grabbit fetch an internal
// service and hand the response back through the library or the browser
// stream.
//
// Set ALLOW_PRIVATE_ADDRESSES=true to turn the guard off — for a deliberately
// LAN-only setup where grabbing from an internal host is the point.

const dns = require('dns').promises;
const net = require('net');

const ALLOW_PRIVATE = /^(1|true|on|yes)$/i.test(String(process.env.ALLOW_PRIVATE_ADDRESSES || ''));

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = (n * 256) + byte;
  }
  return n;
}

// Ranges that are reachable from inside the network but never a legitimate
// download source. 169.254.0.0/16 covers the cloud metadata endpoint.
//
// 198.18.0.0/15 is deliberately NOT here: it is the benchmark range, but
// Fake-IP proxies and VPN clients (sing-box, Clash, Mihomo) resolve real
// hosts into it, and blocking it breaks every download behind such a proxy.
// MeTube shipped that bug as alexta69/metube#1036.
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. 169.254.169.254 metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. 255.255.255.255
];

function isAllowedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // unparseable: refuse rather than guess
  return !BLOCKED_IPV4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

// IPv6 is allow-listed rather than block-listed: only global unicast
// (2000::/3) passes, so loopback, unique-local, link-local, multicast and
// anything unparseable are refused without having to enumerate them.
//
// An IPv4-mapped address is judged by the IPv4 it carries, never by the
// ::ffff:0:0/96 prefix — treating that prefix as private rejects every public
// IPv4 address as well, which is the other bug MeTube shipped.
function isAllowedIpv6(ip) {
  const addr = String(ip).split('%')[0].toLowerCase();
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return isAllowedIpv4(mapped[1]);
  if (addr.startsWith('::')) return false; // ::, ::1 and friends
  const first = parseInt(addr.split(':')[0], 16);
  if (!Number.isFinite(first)) return false;
  return (first & 0xe000) === 0x2000;
}

function isAllowedAddress(ip) {
  if (net.isIPv4(ip)) return isAllowedIpv4(ip);
  if (net.isIPv6(ip)) return isAllowedIpv6(ip);
  return false;
}

// Throws unless every address the host resolves to is publicly routable.
// Every address, not just the first: a host with one public and one internal
// A record must not pass on the strength of the public one.
async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch a ${parsed.protocol.replace(':', '')} URL`);
  }
  if (ALLOW_PRIVATE) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new Error(`Could not resolve host "${host}"`);
    }
  }
  if (!addresses.length) throw new Error(`Could not resolve host "${host}"`);

  const blocked = addresses.find((a) => !isAllowedAddress(a));
  if (blocked) {
    throw new Error(
      `Refusing to fetch "${host}": it resolves to the non-public address ${blocked}. ` +
      'Set ALLOW_PRIVATE_ADDRESSES=true if this is deliberate.'
    );
  }
}

// fetch() that re-checks every redirect hop. A public URL redirecting to an
// internal one is the standard way past a check that only sees the address
// the user typed, so redirects are followed by hand instead of by fetch.
//
// Note the residual gap this cannot close: the host is resolved here and
// again by the fetch itself, so a DNS entry that changes between the two
// (rebinding) is not caught, and yt-dlp runs as a child process whose own
// requests we cannot see at all. Guarding the submitted URL still removes the
// straightforward path.
async function safeFetch(url, options = {}, maxHops = 5) {
  let current = String(url);
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...options, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= maxHops) {
      if (res.body) res.body.cancel().catch(() => {});
      throw new Error('Too many redirects');
    }
    if (res.body) res.body.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
}

module.exports = { assertPublicUrl, safeFetch, isAllowedAddress, ALLOW_PRIVATE };
