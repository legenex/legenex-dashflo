// Production-safe outbound target validation for the native delivery send
// path. An operator-configured SubDelivery.target_url is untrusted input from
// the sender's own point of view: the production process has real network
// access, so a misconfigured or maliciously repointed target must never be
// able to use it as a pivot into internal infrastructure, another container,
// or the cloud metadata endpoint.
//
// This is injected into the isomorphic engine (client/src/lib/distribution/
// directPost.js's ctx.validateTarget) rather than imported there directly, so
// the pure, runtime-agnostic engine module never depends on a Node-only DNS
// API. makeTargetValidator() is the one real implementation, wired in
// wherever a REAL (non-test-mode) send happens: processLead.js's
// runDistribution call and nativeRetryRunner.js's retry send.
//
// Scheme is restricted to http/https (file://, ftp://, gopher://, unix
// sockets and any other scheme are refused outright). The literal hostname
// AND its real resolved address are both checked, so a hostname crafted to
// resolve to a private/link-local/metadata address at send time is caught
// even when the string itself looks public. Redirects are never an issue
// here: directPost.js calls fetch with redirect:'manual' and never
// re-dispatches the Location header, so there is no separate
// validate-then-follow-into-private-network path to close.

import dns from 'node:dns/promises';
import net from 'node:net';

const V4_BLOCKED = [
  ['0.0.0.0', 8],       // "this" network
  ['10.0.0.0', 8],      // RFC1918
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, includes the 169.254.169.254 cloud metadata endpoint
  ['172.16.0.0', 12],   // RFC1918 (covers the default Docker bridge range)
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // TEST-NET-1
  ['192.168.0.0', 16],  // RFC1918
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24],  // TEST-NET-3
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved
];

function ipToLong(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function v4InCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

function isBlockedV4(ip) {
  return V4_BLOCKED.some(([base, bits]) => v4InCidr(ip, base, bits));
}

// IPv6: loopback (::1), unspecified (::), link-local (fe80::/10), unique
// local (fc00::/7), and an IPv4-mapped/compatible address checked against
// the v4 list above.
function isBlockedV6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::1' || norm === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(norm)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // fc00::/7
  // IPv4-mapped, dotted-decimal spelling (::ffff:169.254.169.254).
  const dotted = norm.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedV4(dotted[1]);
  // IPv4-mapped, compressed hex spelling (::ffff:a9fe:a9fe). This is the
  // shape the WHATWG URL parser (url.hostname) actually produces for a
  // bracketed IPv4-mapped literal - it never emits the dotted-decimal form
  // above, so without this branch every IPv4-mapped literal silently
  // bypassed the guard entirely, verified with
  // `new URL('http://[::ffff:169.254.169.254]/x').hostname` ->
  // `[::ffff:a9fe:a9fe]`.
  const hexMapped = norm.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedV4(v4);
  }
  return false;
}

export function isBlockedIp(ip) {
  if (!ip) return true;
  return net.isIP(ip) === 6 ? isBlockedV6(ip) : isBlockedV4(ip);
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// lookup(hostname) -> Promise<Array<string|{address}>>, injectable for tests
// (production default is real DNS resolution via node:dns/promises).
export function makeTargetValidator({ lookup } = {}) {
  const resolve = lookup || ((hostname) => dns.lookup(hostname, { all: true }));
  return async function validateTarget(url) {
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, reason: 'unsupported_scheme' };
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    if (net.isIP(hostname)) {
      return isBlockedIp(hostname) ? { ok: false, reason: 'private_target' } : { ok: true };
    }
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
      return { ok: false, reason: 'private_target' };
    }

    let addrs;
    try { addrs = await resolve(hostname); } catch { return { ok: false, reason: 'dns_resolution_failed' }; }
    const list = Array.isArray(addrs) ? addrs : [addrs];
    if (!list.length) return { ok: false, reason: 'dns_resolution_failed' };
    for (const a of list) {
      const ip = typeof a === 'string' ? a : (a && a.address);
      if (isBlockedIp(ip)) return { ok: false, reason: 'private_target' };
    }
    return { ok: true };
  };
}
