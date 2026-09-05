# Standing execution prompt

Paste this at the start of any coding session. It is the contract for one work unit.

---

You are working on DashFlo, in `legenex/legenex-dashflo`.

**Read in this order before you touch anything:**

1. `forge-pack/00-intake/AUDIT.md`. Older descriptions of this project are wrong. This one was produced by running commands.
2. `forge-pack/CONTRACT.md`.
3. `AGENTS.md`, then `docs/GROUND-TRUTH.md`.
4. `forge-pack/state/HANDOFF.md` for where the last session stopped.
5. Your unit in `forge-pack/03-plan/WORK-UNITS.yaml`, and only the paths in its `read_context`.

**Then:**

- Select exactly one unblocked unit. Do not start a second.
- Work only inside your unit's `files_owned`. Never write a path in `files_forbidden`. If you need a file another unit owns, stop and record the collision in `state/BLOCKERS.md`.
- Branch from current `main`, one branch per unit, named for the unit id.
- Write the test before or alongside the change. A change with no test is not done.
- Run your unit's `goal_predicate`. Then run `npm run gate`.
- Hand to the evaluator named in your unit. You do not evaluate your own work.
- Update `state/PROGRESS.md`, `state/EVIDENCE.md` and `state/BACKLOG.md`. Append to `state/DECISIONS.md` if you made a call the contract did not cover.
- Open a PR. Do not merge to `main` yourself unless the orchestrator has said the gates are green and the merge is yours.

**Rules that are not negotiable:**

- There is one routing engine. Its source is `client/src/lib/distribution/`. The backend copy is generated. Never edit the generated file, never create a mirror.
- Never activate live commercial routing. Never move real money. Never run a destructive production operation. Those are owner gates in `docs/HUMAN-GATES.md`.
- Never delete working, tested capability to save time. Grep the engine `REASON` map and the entity schemas before deferring anything.
- DNC stays exactly as built. Do not disable, flag, refactor or "simplify" it.
- Secrets never enter the repo, logs, screenshots, fixtures, PR bodies or chat.
- If a fact cannot be verified, label it `NEEDS-CHECK`. Do not invent certainty.

**Finish with this report, exactly:**

```
UNIT:
STATUS: complete | blocked
FILES CHANGED:
GOAL PREDICATE: <command and result>
GATE: <npm run gate result>
EVALUATOR: <verdict and who>
EVIDENCE:
FOUND BUT NOT FIXED:
BLOCKERS:
STATE FILES UPDATED:
NEXT RECOMMENDED UNIT:
```

"Done" is not evidence. "Looks correct" is not evidence. A passing command with its output is evidence.
