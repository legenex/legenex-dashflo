import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ensureSchema } from './db/schema.js';
import { ensureMigrationImportSchema } from './db/migrationImportSchema.js';
import { ensureInvariantConstraints } from './db/invariantConstraints.js';
import { attachUser } from './middleware/auth.js';
import { csrfGuard, allowedOrigins } from './middleware/csrf.js';
import { assertStartupConfig } from './lib/startupChecks.js';
import { loadFunctions } from './functions/index.js';
import { createServerClient } from './lib/serverClient.js';
import { startNativeRetryScheduler } from './lib/nativeRetryScheduler.js';
import { startStuckLeadReaper } from './functions/reapStuckLeads.js';

import authRoutes from './routes/auth.js';
import entityRoutes from './routes/entities.js';
import integrationRoutes from './routes/integrations.js';
import functionRoutes from './routes/functions.js';
import publicFunctionRoutes from './routes/publicFunctions.js';
import migrationRoutes from './routes/migrations.js';
import publicSiteRoutes from './routes/publicSite.js';

async function main() {
  // Refuse to boot a production deployment with a development secret, a
  // missing public URL, or an unconfigured database. This runs before anything
  // touches the database or binds a port.
  assertStartupConfig(config);

  await ensureSchema();
  // Additive constraints closing an app-only enforcement gap the W7-INVARIANTS
  // audit found (CapReservation had no DB-level uniqueness despite its own
  // schema comment claiming one). See server/src/db/invariantConstraints.js.
  await ensureInvariantConstraints();
  await ensureMigrationImportSchema();
  const loaded = await loadFunctions();
  console.log(`[dashos] loaded ${Object.keys(loaded).length} functions`);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CORS used to reflect whatever Origin the caller sent while also allowing
  // credentials, which lets any site on the internet make authenticated
  // requests with the user's cookie. In production the allowed set is explicit.
  const origins = allowedOrigins(config);
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      // Same-origin and non-browser callers send no Origin header.
      if (!origin) return callback(null, true);
      if (origins.size === 0) {
        // No PUBLIC_BASE_URL configured. Production refuses to start in this
        // state, so this branch is development only.
        return callback(null, config.env !== 'production');
      }
      return callback(null, origins.has(origin));
    },
  }));

  app.use(cookieParser());

  // Request bodies are bounded per surface rather than allowing 25mb
  // everywhere. Auth payloads are tiny; only the function route carries bulk
  // imports. The first parser that matches a path wins, so the specific mounts
  // come before the general one.
  app.use('/api/auth', express.json({ limit: '64kb' }));
  app.use('/api/entities', express.json({ limit: '2mb' }));
  app.use('/api/functions', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Attach the current user (if any) to every request.
  app.use(attachUser);

  // Cookie-authenticated writes must come from our own origin.
  app.use('/api', csrfGuard(config));

  // Serve uploaded files.
  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadDir));

  // Slow request visibility.
  //
  // A single line per slow request, with no body, no query string, and no
  // caller identity. The route template is enough to find the offender and
  // carries no lead or account data. Threshold is generous so ordinary traffic
  // stays silent and a regression stands out.
  const slowRequestMs = Number.parseInt(process.env.SLOW_REQUEST_MS || '', 10) || 1500;
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (ms >= slowRequestMs) {
        console.warn(`[slow] ${req.method} ${req.baseUrl || ''}${req.route?.path || req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
      }
    });
    next();
  });

  // API surface.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes);
  // Public marketing surfaces. Mounted after the application routes so it can
  // never shadow one of them.
  app.use('/api', publicSiteRoutes);
  app.use('/api/entities', entityRoutes);
  app.use('/api/integrations', integrationRoutes);
  app.use('/api/functions', functionRoutes);
  app.use('/api/migrations', migrationRoutes);
  app.use('/functions', publicFunctionRoutes);

  // Error handler.
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });

  // Serve the built frontend (SPA fallback) when present.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/functions') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  } else {
    console.warn(`[dashos] client build not found at ${config.clientDist} — API only. Run "npm run build" in client/.`);
  }

  app.listen(config.port, () => {
    console.log(`[dashos] server listening on http://localhost:${config.port} (${config.env})`);
  });

  // No-op unless NATIVE_RETRY_WORKER_ENABLED=true, which is unset in every
  // environment today. See server/src/lib/nativeRetryScheduler.js.
  startNativeRetryScheduler(createServerClient());

  // No-op unless STUCK_LEAD_REAPER_ENABLED=true, which is unset in every
  // environment today. See server/src/functions/reapStuckLeads.js.
  startStuckLeadReaper(createServerClient());
}

main().catch((err) => {
  console.error('[dashos] failed to start:', err);
  process.exit(1);
});
