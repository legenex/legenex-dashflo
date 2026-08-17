import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';

import progressSync from '../src/functions/progressSync.js';
import progressReadiness from '../src/functions/progressReadiness.js';
import progressPrompt from '../src/functions/progressPrompt.js';
import { PROGRESS_FUNCTIONS } from '../src/lib/progressAccess.js';
import { json } from '../src/functions/_runtime.js';

/* The Progress backend functions, exercised over HTTP as a caller reaches them.
 *
 * The unit tests in progressAccess.test.js prove the decision. This proves the
 * three handlers actually ask for it, because a correct policy that a handler
 * forgets to call protects nothing. Each function is invoked directly rather
 * than through a mocked registry, so what is under test is the real handler.
 *
 * "If a non-owner manually calls a Progress API endpoint, access must be
 * denied" is the requirement, so these call the endpoints exactly the way a
 * non-owner with a valid session would: a real request, a real body, no
 * cooperation from the frontend.
 */

const HANDLERS = {
  progressSync,
  progressReadiness,
  progressPrompt,
};

const USERS = {
  owner: { id: 'u1', base_role: 'owner', role: 'admin' },
  admin: { id: 'u2', base_role: 'admin', role: 'admin' },
  manager: { id: 'u3', base_role: 'manager', role: 'user' },
  buyer: { id: 'u4', base_role: 'buyer', role: 'user', linked_buyer_id: 'b1' },
  supplier: { id: 'u5', base_role: 'supplier', role: 'user', linked_supplier_id: 's1' },
  adminWithKeys: {
    id: 'u6',
    base_role: 'admin',
    role: 'admin',
    permissions: JSON.stringify({ progress_admin: true, progress_write: true, progress_access: true }),
  },
};

// Records the users the handlers are told about, keyed by id, so the stored
// record lookup inside authorizeProgressCtx resolves to the same shape a real
// database would return.
const RECORDS = new Map(Object.values(USERS).map((u) => [u.id, u]));

// Anything a handler touches after authorization throws. That is deliberate: if
// a refusal ever stops working, the test fails loudly on the first entity read
// instead of quietly passing because the fixture happened to be empty.
const forbiddenEntity = new Proxy({}, {
  get: () => { throw new Error('handler reached entity access after authorization should have refused'); },
});

function dbFor() {
  return {
    entities: new Proxy({}, {
      get: (_t, name) => {
        if (name === 'User') return { get: async (id) => RECORDS.get(id) || null };
        return forbiddenEntity;
      },
    }),
  };
}

let server;
let baseUrl;
let currentUser = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/functions/:name', async (req, res) => {
    const fn = HANDLERS[req.params.name];
    if (!fn) return res.status(404).json({ error: 'Unknown function' });
    const ctx = {
      body: req.body || {},
      user: currentUser,
      db: dbFor(),
      env: process.env,
      json,
    };
    try {
      const result = await fn(ctx);
      if (result && result.__httpResponse) return res.status(result.status).json(result.body);
      return res.json(result ?? {});
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/functions`;
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
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('progress functions are owner only', () => {
  it('covers every function named in the progress set', () => {
    // Keeps this file honest if a fourth progress function is added later.
    expect([...PROGRESS_FUNCTIONS].sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  it('refuses an anonymous caller with 401', async () => {
    for (const name of Object.keys(HANDLERS)) {
      const res = await invoke(null, name);
      expect(res.status, name).toBe(401);
    }
  });

  for (const label of ['admin', 'manager', 'buyer', 'supplier', 'adminWithKeys']) {
    it(`refuses a ${label} account with 403`, async () => {
      for (const name of Object.keys(HANDLERS)) {
        const res = await invoke(USERS[label], name);
        expect(res.status, `${label} ${name}`).toBe(403);
        expect(res.body?.error, `${label} ${name}`).toBe('Forbidden');
      }
    });
  }

  it('leaks nothing in a refusal body', async () => {
    for (const name of Object.keys(HANDLERS)) {
      const res = await invoke(USERS.admin, name);
      const serialized = JSON.stringify(res.body);
      expect(serialized, name).toBe('{"error":"Forbidden"}');
    }
  });

  it('gets past authorization for the owner', async () => {
    /* The owner is not refused.
     *
     * These handlers go on to read ProgressPage and friends, which the fixture
     * deliberately refuses, so a 500 here is the proof: authorization passed and
     * execution continued into the body of the function. What matters for this
     * test is only that the answer is not 401 or 403.
     */
    for (const name of Object.keys(HANDLERS)) {
      const res = await invoke(USERS.owner, name);
      expect([401, 403], `${name} refused the owner`).not.toContain(res.status);
    }
  });
});
