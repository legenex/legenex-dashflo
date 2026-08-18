# DashFlo Agent Operating Instructions

This file is the canonical DashFlo operating contract. It applies to every
coding agent, model and harness working in this repository. Read it completely
before doing any work.

Read `docs/STATE.md` before making changes. Read `docs/PRODUCT-BRIEF.md`,
`docs/REQUIREMENTS.md`, `docs/EXECUTION-PLAN.md`, `docs/HUMAN-GATES.md` and
`docs/BASE44-BOUNDARY.md` when the task touches the areas they cover.

These instructions apply to every task unless the operator explicitly says
otherwise for that task. Harness-specific entrypoint files, such as
`CLAUDE.md`, may add tool-specific guidance but must not contradict this file.
Where any duplicated guidance conflicts, this file wins.

## 1. Product and stack

DashFlo is a self-hosted lead intake, distribution, delivery, billing, portal,
and reporting system. The current cutover slice replaces LeadByte and Base44 for
MVA and Workers Compensation. The wider product is intended to become a dynamic
reporting and operations SaaS.

Current stack: React 18 and Vite in `client`, Express ES modules in `server`,
PostgreSQL with JSONB-backed entity repositories, and dynamically loaded backend
functions. The marketing website is a static build in `marketing/dist`.

## 2. Repository and environments

- GitHub repository: `legenex/legenex-dashflo`
- Local checkout: `/Users/nickallen/Projects/DashFlo`
- Production and release branch: `main`
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

## 3. Source of truth and normal flow

GitHub is the source of truth for application code.

Normal development flow:

coding agent
-> local repository
-> tests
-> commit
-> push main
-> GitHub Actions
-> production VPS

The production VPS is a deployment target, not a normal development
environment.

Do not directly edit production files for ordinary application work.

Do not bypass GitHub Actions merely because direct deployment would be faster.

Ordinary work happens on `main`. Older documents that describe a long lived
cutover branch as the required working branch are superseded by this file.

## 4. Non-negotiable invariants

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
    default and needs no further approval. The operations listed in section 13
    still require explicit human approval.
13. Change generated code only through its source and generator. Commit source
    and output together.
14. Human-facing copy, comments, and documents must not contain em dashes. This
    applies to chat responses as well as to files.

## 5. Start from the current repository state

Before making changes:

- inspect git status
- inspect the current branch
- fetch origin when the task depends on remote state
- understand existing uncommitted changes before touching them
- identify concurrent-session work
- preserve unrelated edits

Never discard unrelated work.

Never assume an uncommitted change belongs to the current task.

Never use destructive commands unless explicitly authorized, including:

git reset --hard
git clean -fd
git restore .
git checkout -- .

Do not stash, revert, overwrite, or reconcile unrelated changes just to obtain a
clean tree. If unrelated changes block the task, say so and ask.

If another agent is actively changing the same files, stop and report the
conflict rather than guessing.

## 6. Inspect before editing

For every requested change:

- locate the actual implementation rather than guessing where it lives
- read the relevant code path and its callers
- understand current behavior before changing it
- identify the architectural and security constraints that apply
- make the smallest coherent change that fully solves the request

Do not guess at root causes when they can be traced from code.

Do not start broad repository audits unless explicitly requested.

## 7. Complete implementations only

Do not leave the operator with fragments they must manually merge.

When updating:

- code
- prompts
- scripts
- workflows
- configuration
- nginx
- documentation

produce the complete integrated result.

Do not give partial snippets or partial files when the agent can make the actual
complete change directly.

## 8. Testing

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

## 9. Git workflow

When the task is complete and the gate passes:

- inspect the final diff
- check for accidental or unrelated changes
- check for secrets
- run git diff --check
- write a clear commit message that says what changed and why
- push main to origin

Do not leave completed work sitting uncommitted unless there is a genuine
blocker.

Do not ask whether routine completed work should be committed and pushed. That
is the default DashFlo workflow.

## 10. Automatic production deployment

A push to `main` triggers `.github/workflows/deploy-production.yml`. The gate job
runs first and the deploy job runs only if the gate passes. The deploy job uses
the `production` environment and concurrency group `production-deploy` with
`cancel-in-progress: false`, so production releases stay serialized and a running
deployment is never killed midway. Keep that serialization.

Do not manually SSH into production for ordinary releases.

After pushing `main`:

- identify the GitHub Actions run caused by that push
- monitor it through completion
- inspect the failing step if it does not succeed
- fix deployment or workflow problems caused by the committed change
- never claim production deployment succeeded until GitHub Actions confirms it

The workflow itself does the following on the host, and it is the only ordinary
path to production: fetch, checkout `main`, `pull --ff-only`, verify the checked
out commit equals the SHA being deployed, `docker compose build app`,
`docker compose up -d --no-deps app`, wait for container health, verify
`http://127.0.0.1:4000/api/health`, run the restricted helper for `marketing` and
then `nginx`, check `docker compose ps`, and check the five public hosts. It
never writes `server/.env`, never recreates PostgreSQL, never removes a volume,
and never issues a certificate.

## 11. Production verification

After a successful deployment, verify the surface the task actually changed. For
a normal release, verify at minimum:

- the GitHub Actions deployment succeeded
- the deployed application health check succeeded
- the relevant public URL responds successfully
- the changed functionality is live, when that can be checked programmatically

If verification requires a browser, say exactly what the operator needs to check
by hand. Never claim browser-only behavior was verified when it was not.

## 12. Human approval gates

Deploying tested, gated application code by pushing `main` is pre-authorized and
needs no further approval. There is no manual deployment gate for an ordinary
application release.

Explicit human approval is still required for:

- production credential creation, rotation or change
- production data mutation or import
- money movement and money writes
- live delivery or other live external business activation
- destructive schema changes
- irreversible cutover or rollback
- unusual infrastructure operations

See `docs/HUMAN-GATES.md` for the gate records. Where that document or `README.md`
describes a cutover branch or a manual deployment gate for ordinary releases,
this file governs.

## 13. Production secrets

Production secrets remain on the VPS in `/opt/apps/dashflo/server/.env`.

Never overwrite that file. Never commit any production environment file.

Never print, expose, copy, or request:

- JWT secrets
- database passwords
- SMTP passwords
- Google app passwords
- API keys
- encryption keys
- DNC hashing secrets
- SSH private keys
- OAuth secrets
- any other production credential

Do not move normal application secrets into GitHub Actions unless there is a
specific architectural reason and the operator explicitly approves it.

## 14. VPS access

For normal application changes:

DO NOT SSH into production.
DO NOT edit the live checkout directly.
DO NOT restart services manually.
DO NOT reload nginx manually.

GitHub Actions handles ordinary deployment.

Manual VPS work is allowed only when the task genuinely requires infrastructure
work the deployment system cannot do, such as:

- initial server provisioning
- operating system or package maintenance
- certificate bootstrap for a new hostname
- sudo or restricted helper script changes
- infrastructure recovery
- production environment secret changes

If manual VPS work is genuinely required, explain why before doing it.

## 15. Database safety

Never:

- destroy the PostgreSQL volume
- recreate the production database
- wipe tables
- reset production state
- import data into production
- run destructive migrations
- overwrite production records

unless the operator explicitly requests the operation and the required safety
checks are complete.

Treat production data operations as serious. Keep preview and read-only steps
clearly separated from write and apply steps in both code and reporting.

## 16. Base44 migration boundary

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

## 17. Progress Control Center

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

## 18. Authentication

Preserve the current Google Identity Services architecture unless the operator
explicitly asks for an auth redesign.

Authentication is not authorization. Do not weaken invitation, role, owner, or
account-linking protections, and keep server-side authorization intact when
changing sign-in. An Invitation carried in from Base44 is marked migrated
history and cannot authorize a Google sign-in.

## 19. Marketing and nginx

- Respect the marketing source and deployment conventions. Authored source and
  overlay files come first; do not edit generated or minified assets blindly
  when an authored source exists.
- The tracked static build lives in `marketing/dist` and is published by the
  restricted helper, not by hand.
- Nginx configuration is stored in `deploy/nginx/` and reaches production
  through GitHub Actions and the restricted helper.
- Never reload nginx unless `nginx -t` succeeded first. The helper does this.
- Ordinary deployments never reissue TLS certificates.

## 20. SMTP and contact

The production mailer uses server-side SMTP, in `server/src/lib/mailer.js` and
`server/src/lib/contactMessage.js`.

- Never place SMTP passwords in source code, in workflow files, or in workflow
  logs.
- The contact recipient stays controlled server-side. The browser must never be
  able to choose an arbitrary mail recipient.

## 21. Security

Never introduce:

- unrestricted passwordless sudo
- production root SSH for ordinary deployments
- broad `.dashflo.io` authentication cookies
- secrets in repository files or in logs
- secret values in browser responses
- client-only authorization for owner or admin functionality
- destructive git shortcuts
- unreviewed production database writes

Prefer narrow server-side authorization and least privilege. Review every diff
for access control, PII, secrets, money paths, live URLs, idempotency, and
generated parity before committing.

## 22. Performance

Preserve the current code splitting, marketing cache behavior, gzip behavior,
and bundle controls unless the task explicitly requires changing them. Do not
regress initial bundle size casually.

## 23. Verified repository facts

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
- The hourly upstream sync under `sync/` is paused at source and is not writing
  to this repository. See `docs/STATE.md`. If it ever resumes, never merge an
  unreviewed sync commit.
- There is no `.claude/` directory in this repository. `npm run gate` is the
  project gate. Older documents that refer to `.claude/hooks/task-gate.sh`
  describe a pack layout that was never installed, and it is not the gate.

## 24. Parallel work and concurrency

Multiple coding agents may work in this repository at the same time.

Before editing:

- inspect git status
- inspect the relevant diffs
- identify whether another agent has changed the files you intend to modify

Do not overwrite concurrent work.

Do not clean the working tree just because it contains changes from another
agent.

If another agent owns the same files or code path, stop and report the
collision.

When creating new files during concurrent work, keep the scope narrow.

Do not commit another agent's unrelated changes unless explicitly instructed or
unless the dependency is unavoidable and clearly reported.

For planned parallel work, use isolated worktrees and assign exact file
ownership. No two agents edit the same file.

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

## 25. Model and harness neutrality

These instructions apply regardless of model or coding harness.

Examples include:

- Claude
- Codex
- Kimi
- Nemotron
- GLM
- DeepSeek
- other local or hosted coding models and VS Code agents

Do not assume a specific model has special permissions.

The harness determines access to:

- filesystem
- terminal
- Git
- GitHub
- network
- external tools

Harness permissions are separate from these instructions. A permission that
allows an action does not authorize an action this contract prohibits, and an
instruction here does not grant a capability the harness withholds.

If a required capability is unavailable, report the limitation rather than
pretending the action succeeded.

## 26. Definition of done

A task is done only when:

- the acceptance behavior was observed, not assumed
- focused checks and `npm run gate` pass
- outbound network was mocked
- the diff was reviewed for access control, PII, secrets, money, live URLs,
  idempotency, and generated parity
- the work is committed and `main` is pushed
- GitHub Actions reported a successful deployment, or the failure is reported
  with its failing step
- the relevant production surface was verified
- `docs/STATE.md` records evidence and rollback for anything beyond a trivial
  change
- no unapproved production action occurred

If a fact cannot be proven, label it `UNPROVEN` and either keep the task open or
move it to the correct human gate.

## 27. Final response format

After completing a normal DashFlo development task, provide a concise completion
report containing:

- what changed
- root cause if the task was a bug
- commit hash
- commit message
- focused test result
- npm run gate result
- push result
- GitHub Actions deployment result
- production verification result
- anything still requiring manual verification

Do not dump unnecessary internal reasoning.

Do not give manual VPS deployment commands if the automatic deployment pipeline
succeeded.

If automatic deployment fails, report the failing GitHub Actions step and fix it
when the cause is the committed change.

## 28. Style

Be direct and execution focused.

Do not repeatedly ask for confirmation for routine implementation, testing,
committing, pushing, or deployment monitoring.

Do not provide fragments the operator must reconcile manually.

Do not use em dashes in responses or drafted project content.
