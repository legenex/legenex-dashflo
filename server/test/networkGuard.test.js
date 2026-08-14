import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';

// Proves the outbound network guard in vitest.setup.js is actually enforcing,
// not merely installed. If this suite passes, no other suite in the run can
// silently reach a live endpoint.
//
// A green run of this file is the evidence for the Phase 0 requirement that all
// tests block outbound network access except explicit loopback mock servers.

const LIVE_HOSTS = [
  'https://api.trustedform.com/verify',
  'https://graph.facebook.com/v19.0/act_1/leads',
  'https://api.leadbyte.co.uk/v1/leads',
  'https://api.xero.com/api.xro/2.0/Invoices',
  'https://hooks.slack.com/services/T0/B0/XXXX',
];

describe('outbound network is blocked in tests', () => {
  it('blocks fetch to live third-party endpoints', async () => {
    for (const url of LIVE_HOSTS) {
      expect(() => globalThis.fetch(url), url).toThrow(/Blocked outbound network call/);
    }
  });

  it('blocks https.request to a live endpoint', () => {
    expect(() => http.request('http://graph.facebook.com/v19.0/me')).toThrow(
      /Blocked outbound network call/,
    );
  });

  it('blocks dns lookup of a non-loopback host', async () => {
    const dns = await import('node:dns');
    await expect(
      new Promise((resolve, reject) =>
        dns.default.lookup('graph.facebook.com', (err) => (err ? reject(err) : resolve())),
      ),
    ).rejects.toThrow(/Blocked outbound network call/);
  });

  it('permits a loopback mock server so tests can still exercise HTTP paths', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const res = await globalThis.fetch(`http://127.0.0.1:${port}/leads`);
    const body = await res.json();
    expect(body).toEqual({ status: 'accepted' });

    await new Promise((resolve) => server.close(resolve));
  });
});

afterAll(() => {});
