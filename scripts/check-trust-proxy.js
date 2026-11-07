#!/usr/bin/env node
'use strict';
// Pre-deploy check: what req.ip becomes under GRABBIT_TRUST_PROXY.
//
// The login throttle keys on req.ip. Too trusting and a forged
// X-Forwarded-For picks its own key; not trusting enough and every visitor
// shares the proxy's address. This runs the proxy-addr that Express will use
// against the trust list and a set of hop chains, and exits 1 on any surprise.
// It changes nothing.
//
// Usage (in the image that is about to be deployed, with the deploy's env):
//   docker run --rm --env-file <(docker exec grabbit env | grep ^GRABBIT_TRUST_PROXY=) \
//     --entrypoint node <image> scripts/check-trust-proxy.js
//   GRABBIT_TRUST_PROXY=... node scripts/check-trust-proxy.js [--proxy-addr <dir>]
// --proxy-addr loads another copy of proxy-addr, to compare two versions.
const path = require('path');

const argi = process.argv.indexOf('--proxy-addr');
const modPath = argi > 0 ? path.resolve(process.argv[argi + 1]) : 'proxy-addr';
const proxyaddr = require(modPath);
const version = require(path.join(argi > 0 ? modPath : path.dirname(require.resolve('proxy-addr')), 'package.json')).version;

const list = (process.env.GRABBIT_TRUST_PROXY || '').split(',').map((v) => v.trim()).filter(Boolean);
if (!list.length) {
  console.log('GRABBIT_TRUST_PROXY is unset: req.ip is the socket peer. Right only for a directly exposed port.');
  process.exit(0);
}
let trust;
try {
  trust = proxyaddr.compile(list);
} catch (e) {
  console.error(`GRABBIT_TRUST_PROXY does not parse: ${e.message}`);
  process.exit(1);
}

// Overridable so the same cases fit another network.
const TRAEFIK = process.env.CHECK_TRAEFIK_IP || '10.0.0.16'; // grabbit's peer on the traefik network
const CF4 = process.env.CHECK_CF_IP || '172.68.10.20'; // inside 172.64.0.0/13
const CF6 = process.env.CHECK_CF_IP6 || '2400:cb00:2049::1';
const LAN = process.env.CHECK_LAN_IP || '192.168.0.50'; // a LAN client hitting the port directly
const CLIENT = '203.0.113.7';
const FORGED = '198.51.100.99';

// [what, socket peer, X-Forwarded-For, expected req.ip]
const CASES = [
  ['visitor via Cloudflare and Traefik', TRAEFIK, `${CLIENT}, ${CF4}`, CLIENT],
  ['visitor via Cloudflare (IPv6 hop) and Traefik', TRAEFIK, `${CLIENT}, ${CF6}`, CLIENT],
  ['forged X-Forwarded-For in front of the real chain', TRAEFIK, `${FORGED}, ${CLIENT}, ${CF4}`, CLIENT],
  ['IPv6 visitor via Cloudflare', TRAEFIK, `2001:db8::7, ${CF4}`, '2001:db8::7'],
  ['IPv4-mapped Cloudflare hop in the chain', TRAEFIK, `${CLIENT}, ::ffff:${CF4}`, CLIENT],
  ['IPv4-mapped Traefik peer (server bound to ::)', `::ffff:${TRAEFIK}`, `${CLIENT}, ${CF4}`, CLIENT],
  ['LAN client straight to the port, forging the header', LAN, FORGED, LAN],
  ['IPv4-mapped LAN client, forging the header', `::ffff:${LAN}`, FORGED, `::ffff:${LAN}`],
  ['Traefik with no header at all', TRAEFIK, null, TRAEFIK],
  ['visitor reaching Traefik directly (no Cloudflare)', TRAEFIK, CLIENT, CLIENT],
];

console.log(`proxy-addr ${version}, ${list.length} trusted ranges`);
let bad = 0;
for (const [what, peer, xff, want] of CASES) {
  const req = { socket: { remoteAddress: peer }, connection: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} };
  let got;
  try {
    got = proxyaddr(req, trust);
  } catch (e) {
    got = `throws: ${e.message}`;
  }
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: req.ip=${got}${ok ? '' : ` (expected ${want})`}`);
}
console.log(bad ? `${bad} case(s) differ: do not deploy until the trust list or the cases are understood.` : 'All cases as expected.');
process.exit(bad ? 1 : 0);
