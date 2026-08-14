# DashFlo autonomous build pack

Prepared against `legenex/legenex-dashflo` at commit `a63144cb0e1a2c000e873e94e5091565f6bbb1c6` on 15 August 2026.

This pack replaces the earlier 18-file plan. It keeps the useful two-week cutover structure, but corrects claims that do not match the self-hosted repository and adds the production security work that was missing.

## The direct assessment

A safe LeadByte and Base44 cutover by 28 August is possible only as a focused production slice. A complete, dynamic, multi-tenant SaaS reporting platform is not a credible two-week promise. The pack therefore handles the work in this order:

1. Make the self-hosted system safe to expose.
2. Make intake durable and globally suppressible.
3. Prove routing, delivery, billing, and portal isolation.
4. Migrate configuration and twelve months of reporting data.
5. Shadow and cut over one supplier at a time.
6. Continue the broader reporting and SaaS build after the cutover is stable.

## What is in the pack

- `MASTER-PROMPT.md`: paste this into a fresh Claude Code session.
- `REPO-AUDIT-2026-08-15.md`: verified findings and corrections.
- `CLAUDE.md`: concise operating contract for the repository root.
- `docs/PRODUCT-BRIEF.md`: consolidated record of Bru's product answers.
- `docs/REQUIREMENTS.md`: locked scope, priorities, and acceptance criteria.
- `docs/EXECUTION-PLAN.md`: dependency-led implementation plan.
- `docs/HUMAN-GATES.md`: the few actions that require Bru.
- `docs/STATE.md`: persistent handoff state for long-running sessions.
- `.claude/settings.json`: project permissions, hooks, and agent-team setting.
- `.claude/agents/*.md`: bounded specialist agents.
- `.claude/hooks/*.sh`: local change and task gates.

## Install

Copy the pack contents into a clean checkout of the repository, preserving paths. Keep the audit report if you want it in the repo, or retain it beside the repo as review evidence.

Before starting Claude Code:

1. Disable or pause the hourly upstream auto-sync job.
2. Confirm the working tree is clean.
3. Create a cutover branch from the audited commit or from a reviewed newer commit.
4. Make the hook files executable.
5. Start an interactive Claude Code session at the repository root.
6. Paste the entire contents of `MASTER-PROMPT.md` once.

Do not start from `main` while the auto-sync job is still writing to it. That creates an uncontrolled moving target and can overwrite autonomous work.

## Expected interaction level

Claude should work without asking Bru for normal engineering choices. It should ask only through a single consolidated decision packet when a human gate is reached. Code changes to sensitive areas are allowed in an isolated branch. Production activation, live credentials, live buyer traffic, money movement, production data mutation, and final cutover remain human-gated.

## First success signal

The first milestone is not a new feature. It is a green, repeatable baseline with:

- all 47 test files collected from the self-hosted layout;
- the current privacy masking failure fixed;
- build and lint green;
- all backend function modules loading cleanly;
- production auth failing closed;
- no live network calls in tests.

Only after that baseline is committed should Claude change intake or routing.
