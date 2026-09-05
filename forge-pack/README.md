# DashFlo forge-pack

An agent-ready execution pack for the remaining DashFlo work: get one supplier live on DashFlo by 16 September 2026.

## What this is

`CONTRACT.md` is the canonical product contract. It replaces the v1 AgentOS Master Discovery, the v2 Master Build Contract and the v2.1 Corrections, all three of which are archived history and must not be read by agents.

Everything else in this pack derives from `CONTRACT.md`.

## What this is NOT

This pack does not replace anything already in the repository. `AGENTS.md`, `docs/GROUND-TRUTH.md`, `docs/HUMAN-GATES.md`, `docs/REQUIREMENTS.md` and `docs/STATE.md` remain authoritative. The pack sits at level 6 in the precedence order defined in `CONTRACT.md` section 1: it owns the remaining work plan, not the machine facts, not the invariants and not the gates.

If an agent finds this pack contradicting the repository about a machine fact, the repository wins and the pack gets corrected in the same commit.

## Install

Copy `forge-pack/` to the repository root on the branch you are working from. It is documentation and scripts only. It changes no application behaviour.

## Start here

1. Read `CONTRACT.md`, then `AGENTS.md`, then `docs/GROUND-TRUTH.md`.
2. Read `03-plan/BUILD-PLAN.md` for the wave order and the critical path.
3. Bossman selects and dispatches Wave 0 from `03-plan/WORK-UNITS.yaml`; Nick does not paste wave prompts.
4. After every unit, update `state/PROGRESS.md`, `state/EVIDENCE.md` and `state/BACKLOG.md`, then reconcile Hermes Kanban.

## The one fact that governs everything

Production has zero active RouteGroup rows. Nothing is routing commercially. The system is built, deployed, gated and backed up; it has never been switched on. The deliverable is Gate C, not construction.
