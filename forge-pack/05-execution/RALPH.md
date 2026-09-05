# Outer loop

For work spanning more than one context window.

Each iteration:

1. Start fresh, unless you are mid-way through a difficult debugging chain whose state is worth more than the reset. The orchestrator decides.
2. Read `state/HANDOFF.md`, `state/BLOCKERS.md`, `state/BACKLOG.md`. Nothing else yet.
3. Read `forge-pack/CONTRACT.md` and `AGENTS.md`.
4. Select exactly one highest-priority unblocked unit from `WORK-UNITS.yaml`.
5. Read only that unit's `read_context`.
6. Implement that unit and nothing else. Unavoidable integration inside its contract is allowed; adjacent improvements are not.
7. Run the goal predicate.
8. Run the evaluator.
9. Update state files.
10. Leave the repository clean: no stray branches, no uncommitted work, no half-applied migration.
11. Exit.

The next iteration starts from disk, never from remembered conversation.

## Exit condition

All units in `WORK-UNITS.yaml` are `done`, or the only remaining units are human-gated and their packets are delivered.

## Stall condition

See `STALL-POLICY.md`. A loop that cannot stall is a loop that burns the window.
