# Legenex DashOS

Standalone lead-distribution & finance dashboard. A React (Vite) frontend and a
Node/Express + PostgreSQL backend. Fully self-contained — no external app
platform. Designed to deploy on a Plesk server (Node app + PostgreSQL).

```
Legenex DashOS/
├── client/            # React + Vite + Tailwind + shadcn/ui frontend
│   ├── src/api/client.js   # the API client (entities, auth, functions, integrations)
│   └── src/functions/*     # thin wrappers that call backend functions
├── server/            # Express API, auth, entity store, ported functions
│   ├── src/schemas/entities/   # data-model definitions (drive the DB tables)
│   ├── src/db/                 # pg pool, schema generation, document repository
│   ├── src/routes/             # auth, entities, integrations, functions
│   ├── src/functions/          # 34 backend functions (lead processing, syncs, AI, …)
│   ├── src/integrations/       # LLM adapter, file upload/extract
│   └── scripts/                # migrate, seed-admin
├── Reference/         # original source (kept for reference; not used at runtime)
└── package.json       # root orchestration scripts
```

## Prerequisites
- Node.js 18+ (developed on Node 22)
- PostgreSQL 14+

## Local setup

```bash
# 1. Install dependencies (server + client)
npm run install:all

# 2. Configure the server
cp server/.env.example server/.env
#   edit server/.env — set PG* connection vars, JWT_SECRET, and (optionally)
#   ANTHROPIC_API_KEY / OPENAI_API_KEY and any integration credentials.

# 3. Create the database (once)
createdb dashos            # or: psql -c 'CREATE DATABASE dashos;'

# 4. Create tables (idempotent — also runs automatically on server start)
npm run migrate

# 5. Create the first owner account
npm run seed:admin -- you@example.com 'your-password' 'Your Name'

# 6a. Development (API on :4000, Vite on :5173 with proxy)
npm run dev
#     open http://localhost:5173

# 6b. Production-style (single server serves the built app)
npm run build              # builds client/dist
npm start                  # serves API + app on :4000
#     open http://localhost:4000
```

## LLM provider
AI features (Overview briefing, DataBot, insights) use a provider-agnostic
adapter. Set `LLM_PROVIDER=anthropic` (default) or `openai` in `server/.env` and
supply the matching API key. Everything else works without an LLM key.

## Integrations
Third-party syncs (LeadByte, HLR, TrustedForm, Meta Ads, Mercury, Stripe, Xero,
Google Sheets, Gmail/SMTP, WhatsApp) are ported and wired behind adapters. Each
degrades gracefully — returning a clear "not configured" until you add its
credentials to `server/.env` (or, for some, into the app's own config records).

## Deploying to Plesk
1. Create a PostgreSQL database in Plesk; note the connection details.
2. Create a Node.js application pointing at `server/` with **Application Startup
   File** = `src/index.js` and **Application Mode** = `production`.
3. Set the environment variables from `server/.env.example` in the Plesk Node UI
   (at minimum: `PG*`/`DATABASE_URL`, `JWT_SECRET`, `PUBLIC_BASE_URL`, and any
   LLM/integration keys). Set `NODE_ENV=production`.
4. Build the frontend (`npm run build`) and upload `client/dist`, or set
   `CLIENT_DIST` to wherever you place it. The server serves it automatically.
5. Run `npm run migrate` and `npm run seed:admin` once from the Plesk Node
   console (or SSH).

## Automatic upstream sync (hourly)

The app can track the source repo and replicate changes into this standalone
build automatically. Two macOS `launchd` agents handle it:

| Agent | What it does |
|---|---|
| `com.legenex.dashos.server` | Keeps the API server running (auto-restart, serves `client/dist`) |
| `com.legenex.dashos.sync` | Every hour: pulls the repo, replicates changes, rebuilds, restarts the server, and commits + pushes to this project's repo |

**Install / update the agents:**
```bash
bash scripts/install-scheduler.sh     # idempotent; sets baseline to current commit
```
**Remove them:**
```bash
bash scripts/uninstall-scheduler.sh
```

**What the sync does** (`sync/sync.mjs`) on each run:
1. `git fetch` the mirror at `.sync/upstream`; if no new commits, it exits.
2. For changed **frontend** files: copies them in and applies the same
   de-coupling transform (platform SDK → `@/api/client`). Files that were
   hand-rewritten for standalone (`api/client.js`, `lib/app-params.js`,
   `lib/AuthContext.jsx`) are never overwritten — if upstream touches their
   originals, it logs a warning to reconcile manually.
3. Syncs changed **entity schemas** (new entities auto-create tables on restart).
4. Regenerates frontend **function shims**.
5. Ports changed **backend functions** (Deno → Node). New functions are ported
   with the `claude` CLI (mechanical fallback) and applied; changed existing
   functions are ported into `sync/state/pending/` and flagged, so a careful
   hand-port is never silently clobbered.
6. Installs any new frontend dependencies the upstream added.
7. Rebuilds `client/dist` and restarts the server (only if something changed and
   the build succeeded — a failed build keeps the previous working `dist`).
8. Commits the replicated changes and pushes them to `origin/main`, so the repo
   stays current with the source automatically. Skips this on a failed build or
   an empty change, and never crashes the sync on a git error (logs a warning and
   retries next run). Disable with `--no-push` or `DASHOS_SYNC_NO_PUSH=1`; the
   commit identity/branch is overridable via `DASHOS_GIT_NAME` / `DASHOS_GIT_EMAIL`
   / `DASHOS_GIT_BRANCH`. Push auth uses the `gh`-configured git credentials.

**Manual controls:**
```bash
node sync/sync.mjs            # run a sync now
node sync/sync.mjs --force    # run even with no new commits
node sync/sync.mjs --init     # set baseline to current commit (no transform)
tail -f sync/state/sync.log   # watch sync activity
launchctl list | grep legenex # agent status
```

Notes: the sync uses the `gh`-configured git credentials, and runs Node via
Homebrew (`/opt/homebrew/bin/node`) under launchd. Backend-function changes are
the one part that may need review — check `sync/state/pending/` and the log after
a sync that touched `base44/functions/*`.

## Notes
- Data model: each entity is a PostgreSQL table with a `JSONB data` column plus
  `id / created_date / updated_date / created_by`. The repository layer
  (`server/src/db/repo.js`) provides the document-style API the app expects.
- Auth: email/password with JWT (bcrypt hashes). The first registered user (or
  the seeded admin) becomes the Owner. Google OAuth is left as an optional add-on.
