# Discovery record

**Track:** brownfield, close to a controlled activation rather than a build.
**Intake mechanism:** host-native picker rounds on 4 September 2026, followed by a direct repository audit.
**Gate status:** PASSED, 4 September 2026.

## Readiness assessment

| # | Dimension | Status | Basis |
|---|---|---|---|
| 1 | Problem and target user | RESOLVED | Replace LeadByte for MVA and WC. Owner, internal staff, buyer and supplier portals |
| 2 | Primary job and trigger | RESOLVED | Get one supplier routing through DashFlo safely |
| 3 | Desired outcome and success | RESOLVED | CONTRACT section 6, Gate C |
| 4 | Critical journeys and failure paths | RESOLVED | Existing engine, receipts, retry runner, plus CONTRACT D1 and D2 |
| 5 | Version-one scope and non-goals | RESOLVED | CONTRACT section 5 and 01-product/DEFERRED.md |
| 6 | Data inputs, ownership, durability | RESOLVED | Durable receipts verified in audit |
| 7 | Identity, roles, permissions, trust | RESOLVED | Existing model retained, D8 |
| 8 | Integrations and sources of truth | RESOLVED | Meta, Ringba, supplier APIs, buyer endpoints, Base44 migration reads per D6 |
| 9 | Platform, deployment, support | RESOLVED | CI deploy verified in audit. Off-site backup is the one open item |
| 10 | Scale, concurrency, volume | RESOLVED | 1,984 leads, 13 buyers, 5 suppliers |
| 11 | Cost of failure, security, recovery | RESOLVED | CONTRACT section 7, backups restore-drilled |
| 12 | Time, team, technology constraints | RESOLVED | 12 days, freeze 12 Sep, Claude Code workers per D10 |
| 13 | Design intent and references | RESOLVED | Preserve current visual system, fix congruence only |
| 14 | Observable completion criteria | RESOLVED | 01-product/ACCEPTANCE.md and unit goal predicates |
| 15 | Existing system, preserved behaviour, migration | RESOLVED | 00-intake/AUDIT.md |
| 16 | Canonical name | RESOLVED | DashFlo. Already owned, live and deployed. Naming gate does not apply |

No dimension is BLOCKED.

## Owner decisions recorded

- Seven lead statuses, with `rejected` meaning a system or field-level rejection and `unsold` meaning no buyer bought it. Reports show unsold totals.
- Live pricing changes on live routes return to owner authority.
- Buyer onboarding returns to launch scope, completion scope only.
- **DNC stays exactly as built.** An earlier instruction to remove it was withdrawn by the owner on 4 September. No DNC work is in this pack beyond mapping a suppressed lead to `rejected` with `REJECTED_DNC`.

## Approved assumptions, reversible

- `America/Chicago` as the single business reporting timezone, matching the current UI clock.
- Exclusive distribution remains the launch mode for MVA and WC.
- LeadFlow is built and tested against first, cut over last.

## Non-blocking checks, owner: agents in Wave 0

- Exact size of the remaining Lead Distribution and Operations congruence gap (W0-AUDIT).
- Exact remaining gap in buyer onboarding (W0-AUDIT feeding W9).

## AgentOS handoff approval, 5 September 2026

Nick explicitly approved the AgentOS discovery readback with: `Approve discovery, DNC stays enabled`.

Additional resolved operating requirements:
- Bossman is the durable project orchestrator.
- Nick is not the wave-prompt router.
- AgentOS must continue work automatically between waves from durable state.
- Buzz and Bossman's business WhatsApp are notification/approval surfaces, not execution-state stores.
- The existing closed `buzz_guard` remains intact.
- Coding uses an approved repo-capable execution path while Hermes/Buzz own orchestration and visibility.
- Human interruption is limited to genuine authority gates described in `agentos/AUTONOMY-AND-APPROVALS.md`.
