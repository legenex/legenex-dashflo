# PROJECT

**Product:** DashFlo, self-hosted lead intake, distribution, delivery, billing, portal and reporting system.
**Owner:** Nick Allen. Final product authority.
**Classification:** brownfield activation. Not greenfield, not rescue.

## Problem

Legenex runs MVA and Workers' Compensation lead generation on LeadByte. DashFlo was built to replace it. The build is essentially done and deployed but has never carried commercial traffic: production has zero active RouteGroup rows.

## Desired outcome

One supplier routing live through DashFlo by 16 September 2026, with LeadByte retained for rollback, followed by tranche-by-tranche expansion and eventual retirement of LeadByte and Base44.

## Scope of this pack

Fourteen work units in `03-plan/WORK-UNITS.yaml`, covering the seven-status migration, the derived money flags that protect historical revenue through it, the stuck lead reaper, honest empty states, fixtures, an invariant audit, list-page congruence, onboarding completion, and then the Gate C packet, shadow run and canary.

## Cost of failure, in the owner's terms

The never-list in `CONTRACT.md` section 7 is the answer. The two that would do real commercial damage: a duplicate commercial sale, and incorrect sale price or revenue. Both are silent failures. Neither shows up as an error; both show up weeks later as a buyer dispute or a wrong bank balance.

## Non-negotiable constraints

- Existing repository authorities are not superseded by this pack: `AGENTS.md`, `docs/GROUND-TRUTH.md`, `docs/HUMAN-GATES.md`, `docs/REQUIREMENTS.md`.
- No agent activates live commercial routing. Ever. That is Gate C and it is the owner's.
- Nothing that already works gets deleted to hit the date.
- Feature freeze 12 September.

## Success metric

Gate C green: one supplier live, zero lost leads, zero duplicate commercial sends, outcomes and money reconciling to source, rollback proven available throughout.
