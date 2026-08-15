# Base44 boundary and the connector context rule

Read this before concluding anything about Base44 availability.

## The mistake this document exists to prevent

A previous agent session reported that the Base44 connector was unavailable,
reasoning from the absence of `mcp__claude_ai_Base44__*` tools in its own tool
list. That reasoning is wrong and it cost a cycle.

**The Base44 connection belongs to the spawned Claude process context, not to
the parent agent's context.** `sync/daily-update.mjs` shells out to separate
`claude -p ...` processes, each launched with
`--allowedTools ToolSearch mcp__claude_ai_Base44__query_entities Write Read Bash`.
Those child processes carry the connector. The parent orchestrating agent does
not need it and generally will not see it.

**The parent agent tool list is not authoritative evidence about that
connection.** Absence of the tool in the parent context says nothing about
whether the refresh can reach Base44. The authoritative evidence is the refresh
log at `sync/state/daily-update.log` and the exported files under
`sync/state/import-export/`.

Do not report Base44 as unavailable. Do not ask whether it is connected. If a
pull genuinely fails, the failure appears in the log as
`[groupN] FAILED after Ns: ...` and that is what to report.

## Two different things that must never be confused

### 1. Data only refresh, permitted

`node sync/daily-update.mjs --no-code`

Reads all 90 entities from the connected Base44 application, applies the
collapse safety gate, and refreshes the DashFlo mirror database. It is the
supported migration path for recovering the old MVP data.

The `--no-code` flag is what keeps it data only. The log line
`[code] skipped (--no-code)` is the proof that the code stage did not run, and
it must be present in every run from here on.

### 2. Legacy automatic code sync, prohibited

`node sync/sync.mjs`, and `daily-update.mjs` without `--no-code`, which calls
`sync.mjs --force`.

This pulls Base44 application code into DashFlo and rewrites files under
`server/src/functions/`. It must not run. DashFlo is a standalone product and
its code lives in GitHub, not in Base44.

Never run:

- `node sync/sync.mjs` in any form
- `node sync/daily-update.mjs` without `--no-code`
- `scripts/install-scheduler.sh`, which reinstalls both writers

`scripts/uninstall-scheduler.sh` is also forbidden, for a different reason: it
stops the API server along with the sync jobs. Use
`scripts/install-server-agent.sh` for the server only.

## Service state

The automatic sync and updater services remain **disabled** and must stay that
way.

- `com.legenex.dashos.sync`: booted out and persistently disabled
- `com.legenex.dashos.updater`: booted out and persistently disabled
- `com.legenex.dashflo.server`: loaded, this is the API server and is wanted

The plists still exist, so anyone running `install-scheduler.sh` revives them.
That is the residual risk and it is a human action, not an automatic one.

A data only refresh is started deliberately, by hand, with `--no-code`. It is
not on a timer, and reviving the timer is what reintroduces the code sync.

## The boundary that must hold

Base44 is a read only reference for tracking the old MVP and recovering
migration requirements. It must never become:

- a DashFlo runtime dependency
- a production host
- an API fallback
- a deployment target
- a production URL

Verified at commit `da555a8`: no Base44 SDK in any manifest, no runtime
endpoint, no fetch. The `base44` strings in the client bundle are all inside
`client/src/lib/progress/backendSummary.json`, a stored snapshot of MVP function
paths used for read only porting progress.

GitHub is the source control remote for the standalone application:
`https://github.com/legenex/legenex-dashflo`. Base44 supplies data during
migration. The two never swap roles.

## What a refresh may and may not touch

May:

1. Read all 90 entities from the connected Base44 application.
2. Apply the collapse protection before importing.
3. Refresh the DashFlo mirror database.
4. Run the documented health and integrity checks.

May not:

5. Change the DashFlo working tree, build, service or Git branch.

The refresh writes only to `sync/state/import-export/`, `sync/state/*.log`,
`sync/state/last-data-refresh.json` and the database. If `git status` shows an
application file changed after a refresh, something ran that should not have.

## Known gap in the refresh pipeline

`sync/import-data.mjs --truncate` issues `DELETE FROM <table>` on every target
table before reimporting, and **the pipeline takes no database backup**. The
directories under `sync/state/backups/` are code file backups written by the
legacy sync engine, not database dumps.

The only protection today is the collapse gate in `daily-update.mjs`,
`MIN_TOTAL_RATIO = 0.9`, which aborts the import when the exported record total
falls below 90 percent of the previous run. That catches a wholesale collapse.
It does not catch a single entity silently returning a partial page while the
total stays within 10 percent.

Take a dump before any refresh until this is fixed:

```
pg_dump -h 127.0.0.1 -p 5433 -d dashos -Fc -f <path>/dashos-pre-refresh-<date>.dump
```

Verify it restores into a disposable database before relying on it. A backup
that has never been restored is a guess.
