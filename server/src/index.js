import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ensureSchema } from './db/schema.js';
import { attachUser } from './middleware/auth.js';
import { loadFunctions } from './functions/index.js';

import authRoutes from './routes/auth.js';
import entityRoutes from './routes/entities.js';
import integrationRoutes from './routes/integrations.js';
import functionRoutes from './routes/functions.js';

async function main() {
  await ensureSchema();
  const loaded = await loadFunctions();
  console.log(`[dashos] loaded ${Object.keys(loaded).length} functions`);

  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Attach the current user (if any) to every request.
  app.use(attachUser);

  // Serve uploaded files.
  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadDir));

  // API surface.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/entities', entityRoutes);
  app.use('/api/integrations', integrationRoutes);
  app.use('/api/functions', functionRoutes);

  // Error handler.
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });

  // Serve the built frontend (SPA fallback) when present.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  } else {
    console.warn(`[dashos] client build not found at ${config.clientDist} — API only. Run "npm run build" in client/.`);
  }

  app.listen(config.port, () => {
    console.log(`[dashos] server listening on http://localhost:${config.port} (${config.env})`);
  });
}

main().catch((err) => {
  console.error('[dashos] failed to start:', err);
  process.exit(1);
});
