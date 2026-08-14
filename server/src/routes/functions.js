import express from 'express';
import { getFunction, functionNames } from '../functions/index.js';
import { createServerClient } from '../lib/serverClient.js';
import { config } from '../config.js';
import { HttpError, json } from '../functions/_runtime.js';
import { authorizeFunction } from '../lib/functionPolicy.js';

const router = express.Router();

// Listing every backend function by name tells an anonymous caller exactly
// what to probe, so the index requires a session.
router.get('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  res.json({ functions: functionNames() });
});

// POST /api/functions/:name  -> runs the ported function. Response mirrors the
// function's own status/body (like the original Deno Response.json).
router.post('/:name', async (req, res) => {
  // Deny by default. Only the reviewed public allowlist in lib/functionPolicy.js
  // may run without a session, and each of those authenticates its own caller.
  // This runs before the function is resolved so an anonymous caller cannot
  // discover which function names exist.
  const decision = authorizeFunction(req.user, req.params.name);
  if (!decision.allowed) {
    return res.status(decision.status).json({ error: 'Unauthorized', message: decision.reason });
  }

  const fn = getFunction(req.params.name);
  if (!fn) return res.status(404).json({ error: `Unknown function: ${req.params.name}` });

  const ctx = {
    body: req.body || {},
    user: req.user || null,
    db: createServerClient(req.user || null),
    env: process.env,
    config,
    req,
    json,
  };

  try {
    const result = await fn(ctx);
    if (result && result.__httpResponse) return res.status(result.status).json(result.body);
    return res.json(result ?? {});
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error(`[function:${req.params.name}]`, err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
