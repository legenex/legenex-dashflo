// Outbound network guard for the test run.
//
// Requirement: tests never reach a live endpoint. No test may contact a real
// HLR, TrustedForm, LeadByte, Meta, buyer, email, Slack, WhatsApp, bank or
// accounting service. Only explicit loopback mock servers are permitted.
//
// This guard is enforcement, not documentation. It patches the outbound call
// surfaces Node exposes and throws on any non-loopback destination, so a test
// that starts calling out fails loudly instead of silently reaching production.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '::ffff:127.0.0.1',
]);

function isLoopback(host) {
  if (!host) return false;
  const clean = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(clean)) return true;
  // Any address in the 127.0.0.0/8 loopback block.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean);
}

class BlockedNetworkError extends Error {
  constructor(target, api) {
    super(
      `Blocked outbound network call to "${target}" via ${api}. ` +
        'Tests must use a loopback mock server. See vitest.setup.js.',
    );
    this.name = 'BlockedNetworkError';
  }
}

function hostFromUrlLike(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return new URL(value).hostname; } catch { return null; }
  }
  if (value instanceof URL) return value.hostname;
  if (typeof value === 'object') {
    if (value.hostname) return value.hostname;
    if (value.host) return String(value.host).split(':')[0];
    if (value.url) return hostFromUrlLike(value.url);
  }
  return null;
}

// fetch
const realFetch = globalThis.fetch;
if (realFetch) {
  globalThis.fetch = function guardedFetch(input, init) {
    const host = hostFromUrlLike(input) ?? hostFromUrlLike(init);
    if (!isLoopback(host)) throw new BlockedNetworkError(host ?? String(input), 'fetch');
    return realFetch.call(this, input, init);
  };
}

// http.request / https.request / http.get / https.get
for (const [mod, name] of [[http, 'http'], [https, 'https']]) {
  for (const method of ['request', 'get']) {
    const real = mod[method];
    mod[method] = function guarded(...args) {
      const host = hostFromUrlLike(args[0]) ?? hostFromUrlLike(args[1]);
      if (!isLoopback(host)) throw new BlockedNetworkError(host ?? String(args[0]), `${name}.${method}`);
      return real.apply(this, args);
    };
  }
}

// net.connect / net.Socket#connect covers raw TCP (database drivers, SMTP).
const realNetConnect = net.connect;
net.connect = function guardedConnect(...args) {
  const opts = args[0];
  const host = typeof opts === 'object' ? (opts.host ?? opts.path ? 'localhost' : null) : args[1];
  if (typeof opts === 'object' && opts.path) return realNetConnect.apply(this, args); // unix socket
  const target = typeof opts === 'object' ? opts.host : host;
  if (!isLoopback(target ?? 'localhost')) throw new BlockedNetworkError(target, 'net.connect');
  return realNetConnect.apply(this, args);
};

// DNS lookups for non-loopback names are themselves an outbound signal.
const realLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) {
    const cb = rest[rest.length - 1];
    const err = new BlockedNetworkError(hostname, 'dns.lookup');
    if (typeof cb === 'function') return cb(err);
    throw err;
  }
  return realLookup.call(this, hostname, ...rest);
};

export { isLoopback, BlockedNetworkError };
