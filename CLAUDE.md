# DashFlo operating contract

Read this file at the start of every session. Read `docs/STATE.md` before making
changes, and read `docs/PRODUCT-BRIEF.md`, `docs/REQUIREMENTS.md`,
`docs/EXECUTION-PLAN.md` and `docs/HUMAN-GATES.md` when the task touches the
areas they cover.

These instructions apply to every task unless the operator explicitly says
otherwise for that task.

## Product

DashFlo is a self-hosted lead intake, distribution, delivery, billing, portal,
and reporting system. The current cutover slice replaces LeadByte and Base44 for
MVA and Workers Compensation. The wider product is intended to become a dynamic
reporting and operations SaaS.

Current stack: React 18 and Vite in `client`, Express ES modules in `server`,
PostgreSQL with JSONB-backed entity repositories, and dynamically loaded backend
functions. The marketing website is a static build in `marketing/dist`.

## Repository and environments

- GitHub repository: `legenex/legenex-dashflo`
- Local checkout: `/Users/nickallen/Projects/DashFlo`
- Production branch: `main`
- Production VPS application path: `/opt/apps/dashflo`
- Production deployment: GitHub Actions, `.github/workflows/deploy-production.yml`
- GitHub environment: `production`
- Environment secret, name only: `DEPLOY_SSH_KEY`
- Environment variables, names only: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`
- Restricted VPS helper: `/usr/local/sbin/dashflo-deploy-root`, supporting
  `marketing` and `nginx`

Production hosts:

- `https://dashflo.io` marketing website, served from disk by nginx
- `https://app.dashflo.io` operator application
- `https://api.dashflo.io` supplier and reporting API
- `https://docs.dashflo.io` public documentation
- `https://progress.dashflo.io` owner-only Progress Control Center

GitHub is the source of truth for application code. The production VPS is a
deployment target, not a development environment.

## Non-negotiable invariants

1. Every real lead path uses one canonical processing service. Simulations and
   dry runs are explicit and inert.
2. Authenticate, commit a sanitized durable receipt, then run business
   validation. Global DNC is the first business validation.
3. A committed receipt is replayable after a crash. Replay cannot double-deliver
   or double-bill.
4. Never store authorization headers, cookies, raw API keys, or secrets in lead
   payloads, logs, exports, fixtures, commits, or prompts.
5. Global DNC enforcement covers every real intake source. Suppressed leads
   remain auditable and are never contacted or delivered.
6. External calls have timeouts, bounded retries, classified outcomes, and test
   doubles. Tests never use live endpoints.
7. Schema evolution is additive until a measured migration and rollback are
   approved.
8. Buyer and supplier access is deny-by-default, row-scoped, and
   field-allowlisted on the server.
9. Generic entity and function routes fail closed. Public access is an explicit
   allowlist.
10. Supplier API keys are hash-only at rest. Reversible destination credentials
    use an opaque reference to server-side protected storage.
11. Do not mint or substitute TrustedForm certificates.
12. Deploying tested, gated application code by pushing `main` is the standing
    default and needs no further approval. Money writes, live delivery
    activation, production data mutation, credential changes, destructive schema
    changes, and cutover or rollback still require the human gates in
    `docs/HUMAN-GATES.md`.
13. Change generated code only through its source and generator. Commit source
    and output together.
14. Human-facing copy, comments, and documents must not contain em dashes. This
    applies to chat responses as well as to files.

## Default task workflow

Follow this for every ordinary development task.

### 1. Start from the current repository state

Before making changes:

- inspect `git status` and the current branch;
- fetch origin when the task depends on remote state;
- understand any existing uncommitted changes before touching them;
- never assume an uncommitted change belongs to the current task;
- preserve work from concurrent sessions.

Never run destructive cleanup unless the operator explicitly authorizes it for
that task:

```
git reset --hard
git clean -fd
git restore .
git checkout -- .
```

Never stash, discard, revert, or overwrite unrelated changes merely to make the
tree clean. If unrelated changes block the task, say so and ask.

### 2. Inspect before editing

- Locate the actual implementation rather than guessing where it lives.
- Read the relevant code path and its callers.
- Understand existing behavior before changing it.
- Identify the security and architectural constraints that apply.
- Make the smallest coherent change that fully solves the request.

Do not guess at a root cause that can be traced from code. Do not start a
repository-wide audit unless the operator explicitly asks for one.

### 3. Complete implementations only

Produce the complete integrated result for code, prompts, scripts,
configuration, workflows, nginx, and documentation. Do not hand back fragments,
partial files, or instructions to merge pieces by hand when the change can be
made directly.

### 4. Testing

Run focused tests for the changed functionality first when that is useful:

```
npx vitest run <path or pattern>
```

Then run the full gate before shipping any normal code change:

```
npm run gate
```

The gate runs seven steps: tests, function loader, client lint, client build,
bundle purity, secret scan, and the em dash check. It is defined in
`scripts/gate.mjs`. It must pass before a change is complete, and a release is
never pushed on a failing gate.

Database-backed suites look for PostgreSQL on `127.0.0.1:5433` and create their
own disposable databases. They skip themselves loudly when no server is
reachable, and a run with them skipped is weaker evidence than a full run.
GitHub Actions provides that database as a service container, so the CI gate and
a local gate with PostgreSQL running are equivalent.

If a gate failure is caused by the requested change, fix it. If a failure is
demonstrably pre-existing or unrelated, report it clearly and do not silently
ignore it. Never claim a test passed unless it actually ran.

Do not declare success based only on compilation. Exercise behavior against
disposable data and local mock services. Tests never reach a live endpoint; the
outbound network guard in `vitest.setup.js` enforces this.

### 5. Git workflow

When the task is complete and the gate passes:

- inspect the final diff;
- check for accidental or unrelated changes;
- check for secrets;
- run `git diff --check`;
- write a clear commit message that says what changed and why;
- push `main` to origin.

Committing and pushing completed, tested work is the default. Do not ask whether
to commit and push after finishing ordinary requested work, and do not leave
completed work uncommitted unless there is a genuine blocker.

### 6. Automatic production deployment

A push to `main` triggers `.github/workflows/deploy-production.yml`. The gate job
runs first and the deploy job runs only if the gate passes. The deploy job uses
the `production` environment and concurrency group `production-deploy` with
`cancel-in-progress: false`, so production releases stay serialized and a running
deployment is never killed midway. Keep that serialization.

After pushing `main`:

- identify the run caused by that push;
- monitor it through completion;
- inspect the failing step if it does not succeed;
- fix deployment or workflow problems caused by the committed change;
- never claim production deployment succeeded until GitHub Actions confirms it.

Do not SSH into the VPS for an ordinary release, and do not bypass GitHub Actions
because a direct deployment would be faster.

The workflow itself does the following on the host, and it is the only ordinary
path to production: fetch, checkout `main`, `pull --ff-only`, verify the checked
out commit equals the SHA being deployed, `docker compose build app`,
`docker compose up -d --no-deps app`, wait for container health, verify
`http://127.0.0.1:4000/api/health`, run the restricted helper for `marketing` and
then `nginx`, check `docker compose ps`, and check the five public hosts. It
never writes `server/.env`, never recreates PostgreSQL, never removes a volume,
and never issues a certificate.

### 7. Production verification

After a successful deployment, verify the surface the task actually changed. For
a normal release, verify at minimum:

- the GitHub Actions deployment succeeded;
- the deployed application health check succeeded;
- the relevant public URL responds successfully;
- the changed functionality is live, when that can be checked programmatically.

If verification requires a browser, say exactly what the operator needs to check
by hand. Never claim browser-only behavior was verified when it was not.

### 8. Report

Close the task with the report format at the end of this file.

## Production secrets

Production secrets stay on the VPS in `/opt/apps/dashflo/server/.env`. Never
overwrite that file and never commit any production environment file.

Never print, expose, copy, or request JWT secrets, database passwords, SMTP
passwords, Google app passwords, API keys, encryption keys, DNC hashing secrets,
SSH private keys, OAuth secrets, or any other production credential.

Do not move normal application secrets into GitHub Actions unless there is a
specific architectural reason and the operator explicitly approves it.

## VPS access

For normal application changes, do not SSH into production, do not edit the live
checkout, do not restart services by hand, and do not reload nginx by hand.
GitHub Actions handles ordinary deployment.

Manual VPS work is allowed only when the task genuinely requires infrastructure
work the deployment system cannot do, such as initial provisioning, operating
system or package maintenance, certificate bootstrap for a new hostname, sudo or
helper script changes, infrastructure recovery, or a production secret change.
When manual VPS work is genuinely required, explain why before doing it.

## Database safety

Never destroy the PostgreSQL volume, recreate the production database, wipe
tables, reset production state, import data into production, run destructive
migrations, or overwrite production records unless the operator explicitly
requests the operation and the required safety checks are complete.

Treat production data operations as serious. Keep preview and read-only steps
clearly separated from write and apply steps in both code and reporting.

## Base44 migration boundary

Base44 is a temporary upstream migration source. The only supported direction is
Base44 to DashFlo.

- Never build DashFlo to Base44 synchronization.
- Never modify Base44 production data unless the operator explicitly asks.
- Never run a Base44 production import, an owner migration apply, or a
  synchronization merely because migration code changed.
- Encrypted migration preview stays read-only.
- A migration apply requires explicit confirmation.
- Never expose migration passphrases or decrypted credentials.

See `docs/BASE44-BOUNDARY.md`.

## Progress Control Center

Progress is separate owner-only internal tooling. Its canonical host is
`https://progress.dashflo.io/`, and it stays absent from ordinary DashFlo
navigation.

- Only the owner role may reach Progress data and functionality.
- Owner-only authorization is enforced on the server in
  `server/src/lib/progressAccess.js`, not in the client and not in nginx.
- Host scoping lives in `client/src/lib/hostScope.js`.
- Do not weaken Progress authorization to admin or to a permission flag unless
  explicitly requested.
- Do not widen the authentication cookie to `.dashflo.io` to share sessions
  between the application host and the Progress host. The cookie stays host
  only.

## Authentication

Preserve the current Google Identity Services architecture unless the operator
explicitly asks for an auth redesign.

Authentication is not authorization. Do not weaken invitation, role, owner, or
account-linking protections, and keep server-side authorization intact when
changing sign-in. An Invitation carried in from Base44 is marked migrated
history and cannot authorize a Google sign-in.

## Marketing and nginx

- Respect the marketing source and deployment conventions. Authored source and
  overlay files come first; do not edit generated or minified assets blindly
  when an authored source exists.
- The tracked static build lives in `marketing/dist` and is published by the
  restricted helper, not by hand.
- Nginx configuration is stored in `deploy/nginx/` and reaches production
  through GitHub Actions and the restricted helper.
- Never reload nginx unless `nginx -t` succeeded first. The helper does this.
- Ordinary deployments never reissue TLS certificates.

## SMTP and contact

The production mailer uses server-side SMTP, in `server/src/lib/mailer.js` and
`server/src/lib/contactMessage.js`.

- Never place SMTP passwords in source code, in workflow files, or in workflow
  logs.
- The contact recipient stays controlled server-side. The browser must never be
  able to choose an arbitrary mail recipient.

## Security

Never introduce:

- unrestricted passwordless sudo;
- production root SSH for ordinary deployments;
- broad `.dashflo.io` authentication cookies;
- secrets in repository files or in logs;
- secret values in browser responses;
- client-only authorization for owner or admin functionality;
- destructive git shortcuts;
- unreviewed production database writes.

Prefer narrow server-side authorization and least privilege. Review every diff
for access control, PII, secrets, money paths, live URLs, idempotency, and
generated parity before committing.

## Performance

Preserve the current code splitting, marketing cache behavior, gzip behavior,
and bundle controls unless the task explicitly requires changing them. Do not
regress initial bundle size casually.

## Verified repository facts

- `Repo.list()` returns an array for an empty result.
- `Lead.buyer_id` is overloaded across legacy code and native routing. Do not
  assume it is always a code or always a record id. Use the additive identity
  migration in the requirements.
- `server/src/functions/processLead.js` is called by several ingestion and
  recovery functions. Inspect all callers before changing intake.
- Backend function files are loaded dynamically. Helper modules must be named
  with a leading underscore or end in `.generated.js` so the loader does not
  treat them as handlers. `npm run verify:functions` checks this.
- Date bucketing currently depends on `America/Regina`. Preserve it unless a
  requirement explicitly changes it.
- Supplier source codes can contain suffixes. Existing longest-prefix behavior
  is compatibility-sensitive.
- The hourly upstream sync under `sync/` is paused at source, see
  `docs/STATE.md`. If it ever resumes, never merge an unreviewed sync commit.
- There is no `.claude/` directory in this repository. `npm run gate` is the
  project gate. Older documents that refer to `.claude/hooks/task-gate.sh`
  describe a pack layout that was never installed.
- `docs/HUMAN-GATES.md` and `README.md` predate automatic deployment. Where they
  describe a cutover branch or a manual deploy gate, this file governs.

## Parallel work

Use isolated worktrees. Assign exact file ownership. No two agents edit the same
file.

Integrator-only surfaces:

- `server/src/functions/processLead.js`
- package files and lockfiles
- database migrations and shared entity schemas
- generated bundles
- distribution mode control
- `.github/workflows/deploy-production.yml`
- final branch integration

Agents may build separate modules and tests in parallel, then the integrator
applies the canonical pipeline change serially.

## Definition of done

A task is done only when:

- the acceptance behavior was observed, not assumed;
- focused checks and `npm run gate` pass;
- outbound network was mocked;
- the diff was reviewed for access control, PII, secrets, money, live URLs,
  idempotency, and generated parity;
- the work is committed and `main` is pushed;
- GitHub Actions reported a successful deployment, or the failure is reported
  with its failing step;
- the relevant production surface was verified;
- `docs/STATE.md` records evidence and rollback for anything beyond a trivial
  change;
- no unapproved production action occurred.

If a fact cannot be proven, label it `UNPROVEN` and either keep the task open or
move it to the correct human gate.

## Final response format

Close a normal DashFlo development task with a concise report containing:

- what changed;
- the root cause, if the task was a bug;
- commit hash;
- commit message;
- focused test result;
- `npm run gate` result;
- push result;
- GitHub Actions deployment result;
- production verification result;
- anything the operator still needs to verify manually.

Do not dump internal reasoning. Do not give manual VPS deployment commands when
the automatic pipeline succeeded. If the automatic deployment failed, name the
failing step and fix it when the cause is the committed change.

## Style

Be direct and execution focused. Do not repeatedly ask for confirmation on
routine implementation, testing, committing, pushing, or deployment monitoring.
Do not hand back fragments that have to be reconciled by hand. Do not use em
dashes.
