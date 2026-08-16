import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  PUBLIC_FUNCTIONS,
  PUBLIC_WITHOUT_OWN_VERIFICATION,
  authorizeFunction,
  isPublicFunction,
} from '../src/lib/functionPolicy.js';

// The generic function route ran any of the 94 loaded functions with no check
// at the route. Whether a caller had to be authenticated depended on whether
// that particular function remembered to call requireUser.
//
// These tests pin the inverted default and the exact contents of the public
// allowlist, so widening it is a visible change rather than a side effect.

const ran = [];

vi.mock('../src/functions/index.js', () => ({
  getFunction: (name) => async (ctx) => { ran.push({ name, user: ctx.user }); return { ok: true, name }; },
  functionNames: () => ['leads', 'health', 'operatorData', 'purgeSeedLeads'],
}));

vi.mock('../src/lib/serverClient.js', () => ({ createServerClient: () => ({ entities: {} }) }));

let server;
let baseUrl;
let publicBaseUrl;
let currentUser = null;

beforeAll(async () => {
  const { default: functionRoutes } = await import('../src/routes/functions.js');
  const { default: publicFunctionRoutes } = await import('../src/routes/publicFunctions.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use('/api/functions', functionRoutes);
  app.use('/functions', publicFunctionRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/functions`;
  publicBaseUrl = `http://127.0.0.1:${server.address().port}/functions`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function invoke(user, name, body = {}) {
  currentUser = user;
  const res = await fetch(`${baseUrl}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, raw: text };
}

const OPERATOR = { id: 'u1', base_role: 'owner', role: 'admin' };

describe('function route denies by default', () => {
  it('refuses an anonymous call to a non-public function', async () => {
    for (const name of ['operatorData', 'purgeSeedLeads', 'systemExport', 'distributionSetMode']) {
      const res = await invoke(null, name);
      expect(res.status, name).toBe(401);
    }
  });

  it('does not run the handler when it refuses', async () => {
    ran.length = 0;
    await invoke(null, 'purgeSeedLeads');
    expect(ran).toHaveLength(0);
  });

  it('refuses before revealing whether the function exists', async () => {
    const real = await invoke(null, 'operatorData');
    const fake = await invoke(null, 'thisFunctionDoesNotExist');
    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
    expect(real.raw).toBe(fake.raw);
  });

  it('allows an authenticated caller through to the handler', async () => {
    ran.length = 0;
    const res = await invoke(OPERATOR, 'operatorData');
    expect(res.status).toBe(200);
    expect(ran).toHaveLength(1);
    expect(ran[0].user.id).toBe('u1');
  });
});

describe('function index is not anonymous', () => {
  it('refuses to list function names without a session', async () => {
    currentUser = null;
    const res = await fetch(baseUrl);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('purgeSeedLeads');
  });

  it('lists them for an authenticated caller', async () => {
    currentUser = OPERATOR;
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('leads');
  });
});

describe('public allowlist', () => {
  it('lets the documented intake surface through unauthenticated', async () => {
    for (const name of ['leads', 'validate', 'spec', 'health']) {
      const res = await invoke(null, name);
      expect(res.status, name).toBe(200);
    }
  });

  it('is exactly the reviewed set', () => {
    // Widening this list must be a deliberate edit to both the policy and this
    // assertion, not a quiet addition.
    expect(Object.keys(PUBLIC_FUNCTIONS).sort()).toEqual([
      'buyerFeedbackWebhook',
      'callWebhook',
      'getOnboardingContext',
      'health',
      'leadbyteWebhook',
      'leads',
      'metaOauthCallback',
      'migrateSource',
      'spec',
      'submitBuyerOnboarding',
      'validate',
      'webhook',
    ]);
  });

  it('mounts only reviewed public handlers on the production /functions path', async () => {
    currentUser = null;
    const leads = await fetch(`${publicBaseUrl}/leads`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const operator = await fetch(`${publicBaseUrl}/operatorData`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(leads.status).toBe(200);
    expect(operator.status).toBe(404);
  });

  it('serves the Meta callback by GET and refuses misleading GETs for lead intake', async () => {
    currentUser = null;
    expect((await fetch(`${publicBaseUrl}/metaOauthCallback?state=test`)).status).toBe(200);
    expect((await fetch(`${publicBaseUrl}/leads`)).status).toBe(405);
  });

  it('documents a reason and an authenticator for every public function', () => {
    for (const [name, meta] of Object.entries(PUBLIC_FUNCTIONS)) {
      expect(meta.reason, `${name} reason`).toBeTruthy();
      expect(meta.authenticatedBy, `${name} authenticatedBy`).toBeTruthy();
    }
  });

  it('keeps operator and destructive functions off the list', () => {
    const mustNotBePublic = [
      'operatorData', 'operationsData', 'systemExport', 'purgeSeedLeads',
      'bulkDeleteLeads', 'dedupeLeads', 'distributionSetMode', 'distributionConfig',
      'generateBillingRun', 'portalData', 'supplierPortalData', 'listUsers',
      'saveMetaAppCredentials', 'sendGmail', 'sendWhatsapp', 'syncXero',
    ];
    for (const name of mustNotBePublic) {
      expect(isPublicFunction(name), `${name} must not be public`).toBe(false);
      expect(authorizeFunction(null, name).allowed).toBe(false);
    }
  });

  it('tracks which public functions still lack their own verification', () => {
    // This is a visible, tested gap rather than a silent one. Both are inbound
    // webhooks whose signature contract needs the third-party details.
    for (const name of PUBLIC_WITHOUT_OWN_VERIFICATION) {
      expect(PUBLIC_FUNCTIONS[name]).toBeDefined();
      expect(PUBLIC_FUNCTIONS[name].authenticatedBy).toMatch(/none yet/);
    }
    // Everything else on the list claims a real authenticator.
    for (const [name, meta] of Object.entries(PUBLIC_FUNCTIONS)) {
      if (PUBLIC_WITHOUT_OWN_VERIFICATION.includes(name)) continue;
      expect(meta.authenticatedBy, `${name}`).not.toMatch(/none yet/);
    }
  });
});
