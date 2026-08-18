# CLAUDE.md

Read `AGENTS.md` completely before doing any work. `AGENTS.md` is the canonical
DashFlo operating contract and must be followed for every task.

This file adds only Claude Code specific guidance. It does not restate the
operating contract. If anything here ever appears to conflict with `AGENTS.md`,
`AGENTS.md` wins, and the conflicting text here should be removed rather than
worked around.

## Session startup

At the start of every session:

1. Read `AGENTS.md`.
2. Read `docs/STATE.md`, which is the persistent handoff between sessions and
   agents.
3. Read `docs/PRODUCT-BRIEF.md`, `docs/REQUIREMENTS.md`,
   `docs/EXECUTION-PLAN.md`, `docs/HUMAN-GATES.md` and
   `docs/BASE44-BOUNDARY.md` only when the task touches the areas they cover.

Then follow the workflow in `AGENTS.md` for the task itself.

## Project-local tooling

There is no `.claude/` directory in this repository. There are no project hooks,
project subagents, project slash commands or project settings, and nothing runs
a gate automatically on your behalf.

`npm run gate` is the project gate and you must run it yourself. Older documents
that refer to `.claude/hooks/task-gate.sh` describe a pack layout that was never
installed here.

Use the `gh` CLI to identify and monitor the GitHub Actions run after pushing
`main`. Do not use SSH for an ordinary release.

## Subagents and parallel sessions

Claude Code subagents and parallel sessions are permitted, and the concurrency
and file ownership rules in `AGENTS.md` section 24 apply to them exactly as they
apply to separate agents.

- Give each subagent explicit file ownership. No two subagents edit the same
  file.
- Keep the integrator-only surfaces listed in `AGENTS.md` section 24 in a single
  serial session. Do not let a subagent edit them.
- A subagent reports evidence back. Only the main session runs `npm run gate`,
  commits, pushes and monitors the deployment.
- Never let a subagent take a production action, and never let one bypass a
  human gate on the strength of its own reasoning.

## Reporting

Close a task with the completion report in `AGENTS.md` section 27, and keep to
the style rules in `AGENTS.md` section 28, including no em dashes in chat
responses.
