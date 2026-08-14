# DashFlo operating contract

Read this file at the start of every session. Read `docs/PRODUCT-BRIEF.md`, `docs/REQUIREMENTS.md`, `docs/EXECUTION-PLAN.md`, `docs/HUMAN-GATES.md`, and `docs/STATE.md` before making changes.

## Product

DashFlo is a self-hosted lead intake, distribution, delivery, billing, portal, and reporting system. The current cutover slice replaces LeadByte and Base44 for MVA and Workers Compensation. The wider product is intended to become a dynamic reporting and operations SaaS.

Current stack: React 18 and Vite in `client`, Express ES modules in `server`, PostgreSQL with JSONB-backed entity repositories, and dynamically loaded backend functions.

## Non-negotiable invariants

1. Every real lead path uses one canonical processing service. Simulations and dry runs are explicit and inert.
2. Authenticate, commit a sanitized durable receipt, then run business validation. Global DNC is the first business validation.
3. A committed receipt is replayable after a crash. Replay cannot double-deliver or double-bill.
4. Never store authorization headers, cookies, raw API keys, or secrets in lead payloads, logs, exports, fixtures, commits, or prompts.
5. Global DNC enforcement covers every real intake source. Suppressed leads remain auditable and are never contacted or delivered.
6. External calls have timeouts, bounded retries, classified outcomes, and test doubles. Tests never use live endpoints.
7. Schema evolution is additive until a measured migration and rollback are approved.
8. Buyer and supplier access is deny-by-default, row-scoped, and field-allowlisted on the server.
9. Generic entity and function routes fail closed. Public access is an explicit allowlist.
10. Supplier API keys are hash-only at rest. Reversible destination credentials use an opaque reference to server-side protected storage.
11. Do not mint or substitute TrustedForm certificates.
12. Money writes, live delivery, production data mutation, credentials, deploys, and cutover require the human gates in `docs/HUMAN-GATES.md`.
13. Change generated code only through its source and generator. Commit source and output together.
14. Human-facing copy, comments, and documents must not contain em dashes.

## Verified repository facts

- `Repo.list()` returns an array for an empty result.
- `Lead.buyer_id` is overloaded across legacy code and native routing. Do not assume it is always a code or always a record id. Use the additive identity migration in the requirements.
- `processLead.js` is called by several ingestion and recovery functions. Inspect all callers before changing intake.
- Backend function files are loaded dynamically. Helper modules must be explicitly excluded or named so the loader does not treat them as handlers.
- Date bucketing currently depends on `America/Regina`. Preserve it unless a requirement explicitly changes it.
- Supplier source codes can contain suffixes. Existing longest-prefix behavior is compatibility-sensitive.
- The repository can be changed by an hourly upstream sync. Work on an isolated cutover branch and never merge an unreviewed sync.

## Autonomy

Normal code and isolated branch changes do not require Bru. This includes sensitive files such as `processLead.js` when the task has tests, an independent review, and no live activation.

Human approval is required only for production activation, credentials, live third-party calls, production data mutation, money movement, protected-branch push, destructive schema changes, and cutover or rollback.

Consolidate questions into the next gate packet. Continue all independent tasks before asking.

## Work loop

1. Define behavior, owned files, side-effect boundaries, tests, and rollback.
2. Read the implementation and all callers.
3. Add or repair tests.
4. Implement one bounded concern.
5. Run targeted checks, then `.claude/hooks/task-gate.sh`.
6. Review the diff for access control, PII, secrets, money, live URLs, idempotency, and generated parity.
7. Obtain independent reviewer PASS. Security-sensitive work also needs security reviewer PASS.
8. Commit on the cutover branch and update `docs/STATE.md`.
9. Continue to the next ready task.

Do not declare success based only on compilation. Exercise behavior against disposable data and local mock services.

## Parallel work

Use isolated worktrees. Assign exact file ownership. No two agents edit the same file.

Integrator-only surfaces:

- `server/src/functions/processLead.js`
- package files and lockfiles
- database migrations and shared entity schemas
- generated bundles
- distribution mode control
- final branch integration

Agents may build separate modules and tests in parallel, then the integrator applies the canonical pipeline change serially.

## Definition of done

A task is done only when:

- acceptance behavior is observed;
- targeted and full gates pass;
- outbound network was mocked;
- independent review passes;
- evidence and rollback are recorded in `docs/STATE.md`;
- no unapproved production action occurred.

If a fact cannot be proven, label it `UNPROVEN` and keep the task open or move it to the correct human gate.
