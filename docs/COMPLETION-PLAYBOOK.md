# DashFlo completion playbook, version 2

`docs/CURRENT-FOLDER-MASTER-PROMPT.md` is pasted once, at the start, into Claude
Code opened at `/Users/nickallen/Documents/Projects/Legenex Dashflo`.

Everything below is an intervention. Each one is a single paste. Use the
smallest one that fits the failure. Do not restate the whole master prompt.

Quick index of failure to fix:

| What you see | Use |
|---|---|
| Session died, context limit, laptop restart | Prompt 1 |
| "Phase complete" with no observed behavior | Prompt 2 |
| Stops after one task and asks what next | Prompt 3 |
| Asks for many credentials or config separately | Prompt 4 |
| Talks about legenex.com, Base44 runtime, or a redesign | Prompt 5 |
| Clones, branches, or makes a worktree | Prompt 6 |
| Touches the sync or updater agents | Prompt 7 |
| Proposes switching everything at once | Prompt 8 |
| Everything is claimed done | Prompt 9 |
| Tests pass but you do not believe them | Prompt 10 |
| It is stuck in a loop or rewriting the same file | Prompt 11 |

Two failures are guarded inside existing prompts rather than new ones: removing
or absorbing existing route-member and buyer suppression is covered by Prompt 2,
and a blank configuration spreadsheet is covered by Prompt 4.

---

## Prompt 1: resume after interruption

Open a fresh Claude Code session in the same folder and paste:

> Resume DashFlo completion work in the current folder. Do not clone,
> initialize, copy or create a repository, development branch or worktree.
> Read `docs/GROUND-TRUTH.md` first. It is current-machine evidence and it
> overrides stale claims about machine state, repository state, ports, paths,
> services, database contents and observed behavior. It does not override Bru's
> decisions, security and privacy invariants, legal suppression obligations,
> locked requirements or human gates, which all rank above it. Then read
> `docs/CURRENT-FOLDER-MASTER-PROMPT.md`, `CLAUDE.md`, `STATE.md`, current git
> status and recent commits. Confirm you are on
> `claude/dashflo-production-cutover-e1tgel`, that the last commit recorded in
> `STATE.md` exists, and that the working tree matches what `STATE.md` claims.
> Confirm `http://localhost:4000/` still serves the interface and `/api/health`
> returns 200. Run `npm run gate`. If green, continue from the first incomplete
> ready task without repeating completed work. If red, repair the regression
> first and record what regressed. DashFlo is separate from Base44; Base44 is a
> read-only MVP tracking and migration source only. Localhost is authoritative,
> `dashflo.io` hosts are the production configuration targets, and the design is frozen.
> All writes stay in this folder, reviewers are read-only. Commit and push green
> checkpoints to the existing feature branch only. Continue until a human gate
> or a verified blocker.

## Prompt 2: challenge a premature completion claim

> Do not summarize or close that phase. Re-read its acceptance criteria and
> prove each one against the running local application, using a reserved
> disposable test database on PostgreSQL port 5433 and loopback mocks. For each
> criterion, show me the exact test that would fail if the behavior were
> removed, and show it failing when you remove it. Then prove you broke nothing
> that already worked: existing route-member and buyer suppression must still
> return `REASON.SUPPRESSED`, still exclude only that buyer, still render the
> same operator messaging, and still pass `engine.test.js` unchanged, and the
> generated backend engine must still match its source. Run the full gate,
> inspect the complete diff, obtain an independent read-only reviewer PASS, and
> update `STATE.md` with observed behavior, commit, rollback and remaining risk.
> If any criterion is unproven, the task stays open and you keep implementing.
> Compilation, code inspection and a written claim are not evidence.

## Prompt 3: force autonomous continuation

> Continue automatically. Read `STATE.md` and the task ladder, select the next
> ready incomplete task, define its contract, implement it, test it, review it,
> commit it, push the existing feature branch, update state, then select the
> next one and repeat. Do not ask me to choose libraries, file layouts, naming,
> test strategy or any other ordinary engineering decision; make the call and
> record it. Stop only for a live credential value, production data mutation, a
> live external call, a deployment or cutover, money movement, a destructive
> operation, or a blocker you have verified cannot be resolved locally.

## Prompt 4: consolidate a gate request

> Consolidate this into one Gate B packet. First recover everything you can from
> the live database, exports, code, entity schemas, repository history, BigQuery
> metadata and safe local experiments. Then give me one exceptions list
> containing only unresolved business decisions and credential reference names.
> Never request or display a credential value in chat. For every decision,
> include your recommended answer and the consequence of choosing it, so I can
> reply with a list of confirmations rather than research. Any sheet you send me
> must arrive pre-populated with what you recovered, showing the source of each
> value, so my job is confirming and correcting rather than typing. A blank
> configuration spreadsheet is a failed recovery: go back and recover more. Send
> the exceptions sheet only, never credential values, and never a credential
> value in chat, a log, a fixture, an export or a client response. Keep
> implementing against mocks while the gate is pending.

## Prompt 5: correct product identity, URLs and design scope

Use this the moment you see `legenex.com`, Base44 treated as runtime, or any
proposal to modernize the interface.

> Correct the product boundary before continuing. The product is DashFlo, a
> separate self-hosted application. Base44 is only a read-only source for
> tracking and migrating the temporary MVP; it is never a runtime dependency,
> authentication provider, function host, URL authority or availability
> dependency, and Base44-sourced code is never applied automatically. Localhost
> is authoritative for current development: the application and API run at
> `http://localhost:4000`, health at `/api/health`, optional Vite dev at
> `http://localhost:5173`. Production hosts are `https://dashflo.io`,
> `https://api.dashflo.io` and `https://docs.dashflo.io`. The
> `legenex.com` hosts are inherited Base44-era fallbacks and are not DashFlo
> URLs; a hardcoded host is never evidence of where this application is
> deployed. Route every host through the environment-aware configuration
> module. Preserve the current design exactly apart from DashFlo naming, URL
> corrections, security states and controls a task genuinely requires. Do not
> redesign, modernize, restyle or reorganize navigation. Re-read
> `docs/GROUND-TRUTH.md` and correct any document that contradicts it.

## Prompt 6: workspace violation

Use this if it clones, creates a branch, creates a worktree, or starts editing
somewhere other than this folder.

> Stop. Undo that. All work happens in
> `/Users/nickallen/Documents/Projects/Legenex Dashflo` on the existing remote
> branch `claude/dashflo-production-cutover-e1tgel`. Do not clone, initialize or
> create a repository, do not copy the application elsewhere, do not create a
> new branch, and do not create or use a git worktree. Two broken worktrees
> already exist from the folder rename, `cutover-local` and `iodized-spoon`, and
> both are to be pruned rather than used or repaired. Specialist agents are
> read-only; every write is yours, in this folder. Tell me exactly what you
> created outside this folder, remove it, confirm `git worktree list` shows only
> this working copy, and resume from the last green commit.

## Prompt 7: scheduler violation

Use this if it runs `install-scheduler.sh`, `uninstall-scheduler.sh`, or touches
the sync or updater labels.

> Stop and reverse that immediately. `com.legenex.dashos.sync` and
> `com.legenex.dashos.updater` are unloaded and must stay unloaded; they are
> mutating writers on this checkout and keeping them off is Gate A.
> `scripts/install-scheduler.sh` rewrites and bootstraps all three agents and
> runs `sync.mjs --init`, so it is forbidden. `scripts/uninstall-scheduler.sh`
> also stops the API server, so it is forbidden too. Only the server label may
> be installed, repointed, booted out, bootstrapped or kickstarted, and only at
> `/Users/nickallen/Documents/Projects/Legenex Dashflo`. Show me
> `launchctl list | grep legenex` and `launchctl print gui/501/...` for all
> three labels, confirm the sync and updater are not loaded, confirm
> `http://localhost:4000/` still serves the interface, and record the evidence
> in `STATE.md`.

## Prompt 8: cutover discipline

> Reject an all-at-once cutover. Prepare one supplier manifest, prove the kill
> switch and the rollback, keep legacy authoritative, run native shadow
> completely inert, and reconcile buyer, price, cap, schedule, DNC, delivery and
> ledger outcomes. Present Gate C for one low-risk supplier only. Broader
> cutover requires that first supplier's operating evidence and Gate D.

## Prompt 9: final hostile production readiness audit

Use only after every implementation task is claimed complete.

> Perform a hostile production readiness audit of the current DashFlo folder.
> Do not modify production and do not call live services. Re-run the full gate,
> then verify by observed behavior: authentication, entity policy, function
> policy, portal isolation, supplier key hashing, credential encryption and
> partial-update merge behavior, durable receipt crash recovery, DNC enforcement
> across every intake caller, transport idempotency, business duplicate
> handling, buyer identity reconciliation, cap concurrency against PostgreSQL,
> delivery response parsing, retry behavior, ledger idempotency, returns,
> migration reconciliation, shadow inertness, backup restoration, monitoring,
> load, latency, cutover kill switch and rollback. Treat every missing artifact
> and every unobserved behavior as a failure, not a caveat. Fix local failures,
> obtain independent general and security reviews, and produce Gate C only when
> every required evidence item is linked to an exact commit and a reproducible
> command I can run myself.

## Prompt 10: verify the tests are worth trusting

> I do not trust this suite yet. Prove it has teeth. For the five most important
> behaviors in the work you just completed, delete or invert the implementation
> one at a time, show me the exact test that fails and its output, then restore
> it. Report any behavior where nothing failed, and write the missing test.
> Separately, confirm no test reaches a live buyer, supplier, HLR, TrustedForm,
> Meta, Xero, banking, email, Slack or WhatsApp endpoint, and show the network
> guard rejecting a non-loopback call. Confirm the suite runs only against a
> reserved test-only database on port 5433, and show me the harness hard-failing
> when pointed at `dashos` or at any database containing live leads, bank rows
> or billing rows. A warning is not enough; it must abort.

## Prompt 11: break a loop

Use this if it keeps rewriting the same file, or re-litigating a decision.

> Stop editing. Do not touch another file yet. In plain text tell me: what task
> you are on, what you have tried, exactly what is failing with the real error
> output, and the two options you are choosing between with your recommendation.
> Then take your recommendation, implement it once, and if it fails again, mark
> the task blocked in `STATE.md` with the evidence, move to the next ready task,
> and tell me at the next gate. Do not retry the same approach a third time.

---

## Handoff block, printed at every context limit

When approaching a context limit, the agent must stop at a clean commit and
print this block. Paste it into the next session after Prompt 1.

```
DASHFLO HANDOFF
Branch:            claude/dashflo-production-cutover-e1tgel
Last green commit: <sha> <subject>
Gate result:       <files> files, <n> passed, <n> failed, functions <n>, lint/build/secrets/em-dash <pass|fail>
Localhost:         / <code>, /api/health <code>, PID <pid>, path <path>
Scheduler:         sync <loaded|not loaded>, updater <loaded|not loaded>, server <loaded|not loaded>
Completed:         <task ids>
In progress:       <task id> at <exact stopping point>
Blocked:           <task id> because <evidence>
Next ready task:   <task id>
Open gate:         <none|A|B|C|D> and what it needs
Uncommitted:       <none|files>
```

## What Bru should expect

Many commits is fine, provided each one is bounded, tested, reviewed and pushed
to the existing feature branch. Long silences while the agent works are normal
and are the intended behavior.

Bru should never be asked to: choose ordinary libraries or implementation
details, type buyer configuration manually into forms, recreate information that
exists in exports or code, paste a credential into chat, approve an untested
change, or switch all suppliers at once.

Bru will still need to: place live secrets directly into the approved secret
mechanism, approve production data migration, approve the first live supplier,
approve later cutover tranches, and approve retirement of LeadByte and Base44.
Roughly fourteen to eighteen hours of Bru's time across the fortnight, most of
it configuration confirmation, which is why the C1 spreadsheet template ships
early rather than late.
