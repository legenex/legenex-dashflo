# Claude Code

## Session start

Paste `forge-pack/05-execution/EXECUTION-PROMPT.md`, then the wave prompt for the current wave.

The repository already has `CLAUDE.md` and a 27 KB `AGENTS.md` as the canonical agent contract. This pack does not replace either. Read them.

## Repo commands, verified 4 September 2026

| Purpose | Command |
|---|---|
| Install everything | `npm run install:all` |
| Dev | `npm run dev` |
| Tests | `npx vitest run` |
| **Full gate** | `npm run gate` |
| Migrations | `npm run migrate` |
| Secret scan alone | `npm run scan:secrets` |
| Engine parity alone | `node scripts/check-engine-parity.mjs` |

Database-dependent suites skip themselves when no database is reachable. CI runs `postgres:16` on port 5433 with `PGPORT_TEST=5433`. A gate run with those suites skipped is not evidence.

## Git

Branch from current `main`, one branch per unit named for the unit id. Branch, PR, squash merge. Never direct commits to `main`. Never reset or clean another session's work. Escalate conflicts in shared files to the orchestrator rather than picking a version.

## Deployment

Push to `main` runs the gate in CI and then deploys to production. That means **merging to main is deploying.** Treat every merge as a production action and make sure the gate is green and the unit's evaluator has passed before requesting it.

## Traps specific to this repository

- `routingEngine.generated.js` is generated. Editing it directly fails `npm run gate` on the parity check, and rightly so. Change `client/src/lib/distribution/` and regenerate.
- Base44 code is live migration machinery, not dead weight. `docs/BASE44-BOUNDARY.md` governs it. Do not grep and delete.
- DNC is enabled and stays enabled. It is also Gate C evidence.
- The em-dash check is a real gate step. Write plainly and it never fires.
