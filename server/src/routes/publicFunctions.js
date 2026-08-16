import express from 'express';
import { executeFunction } from './functions.js';

const router = express.Router();

// Compatibility surface used by suppliers and third-party OAuth redirects.
// Only functionPolicy's explicit public allowlist can run here.
router.post('/:name', (req, res) => executeFunction(req, res, { publicOnly: true }));
router.get('/:name', (req, res, next) => {
  if (req.params.name !== 'metaOauthCallback') return next();
  return executeFunction(req, res, { publicOnly: true });
});

// Do not let a GET for /functions/leads fall through to the SPA and return a
// misleading 200 HTML page. The intake method is POST.
router.all('/:name', (_req, res) => res.status(405).json({ error: 'Method not allowed' }));

export default router;
