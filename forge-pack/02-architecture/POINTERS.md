# Architecture pointers

This pack does not contain architecture documents, because the repository already has them and duplicating them would create a second source of truth that drifts.

| Question | Read this, in the repo |
|---|---|
| What is true about this machine right now | `docs/GROUND-TRUTH.md` |
| What are the agent invariants | `AGENTS.md` |
| What are the locked requirements | `docs/REQUIREMENTS.md` |
| What decisions are accepted | `docs/adr/`, `docs/STATE.md` accepted architecture section |
| How does the routing engine work | `client/src/lib/distribution/` is the source. `server/src/functions/routingEngine.generated.js` is generated from it. Never edit the generated file |
| How is drift prevented | `scripts/check-engine-parity.mjs` |
| How does deployment work | `.github/workflows/deploy-production.yml`, `docs/PRODUCTION-CUTOVER-RUNBOOK.md` |
| How do backups and restores work | `docs/BACKUP-RESTORE.md`, `deploy/backup/` |
| What is the Base44 boundary | `docs/BASE44-BOUNDARY.md` |
| What needs a human | `docs/HUMAN-GATES.md` |
| What happened and when | `docs/STATE.md` |

## The one architectural rule agents break most often

There is exactly one routing engine. Its source lives under `client/src/lib/distribution/`. The backend copy is generated. If you change routing behaviour, change the source and regenerate. `npm run gate` fails on drift and also fails if a hand-written mirror reappears in `server/src/functions`. Do not defeat it.
