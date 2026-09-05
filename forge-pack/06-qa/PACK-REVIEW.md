# Pack review

Adversarial self-review against the FORGE failure list, before handoff.

**Verdict: PASS, with two disclosed limitations.**

## Checks

| Check | Result |
|---|---|
| Discovery gate passed before architecture or work graph | Pass. Gate passed 4 Sep after picker rounds and a repository audit. Recorded in `00-intake/DISCOVERY.md` |
| Host-native picker used, not a static question list | Pass |
| Brownfield system audited before the questionnaire | Pass, and the audit overturned five decisions in the previous draft |
| No applicable readiness dimension left BLOCKED | Pass, sixteen dimensions resolved |
| Approved assumptions presented as assumptions, not facts | Pass, `00-intake/DISCOVERY.md` |
| Naming gate | Not applicable. DashFlo is live, owned and deployed |
| Every claim about existing code carries evidence | Pass. `00-intake/AUDIT.md` is command output. Nothing is asserted from the v1 document |
| Current tool capability verified, not assumed | Pass. Gate steps, CI workflow and test counts were run or read, not remembered |
| Every requirement has a verification method | Pass, `01-product/REQUIREMENTS.md` |
| Every requirement has an implementation path | Pass, `03-plan/TRACEABILITY.md`, no orphans |
| Every work unit has a goal predicate or a named human check | Pass. Fourteen units, thirteen machine predicates, one human (W12-CANARY) |
| Parallel units share no writable file | Pass, validated per wave by script |
| Shared files have an integration owner | Pass, `agents/integrator.md`. W1 and W2 are sequenced rather than concurrent |
| Critical path stated | Pass, `03-plan/WORK-GRAPH.md` |
| Human blockers visible, not buried | Pass, `03-plan/HUMAN-PATH.md`, five items, two already open in `state/BLOCKERS.md` |
| No loop can run forever | Pass, `05-execution/STALL-POLICY.md` and a bounded repair budget |
| Builder is not the only evaluator | Pass, eight units require a named specialist evaluator |
| Root instructions not generic or bloated | Pass. This pack does not write a root `AGENTS.md`; the repository already has one and it stays authoritative |
| Host adapters agree on the source of truth | Pass. Both name `CONTRACT.md`, and both defer to the repository for machine facts |
| Remote side effects off by default | Pass. Merging to `main` deploys, and `08-hosts/CLAUDE-CODE.md` says so explicitly |
| No secrets requested in project files | Pass |
| Not built for unsupported scale | Pass. 1,984 leads, 13 buyers, 5 suppliers. Two to four agents, not six |
| Deferred scope stated | Pass, `01-product/DEFERRED.md` |
| Deadline presented with the risks that could invalidate it | Pass, `02-architecture/RISKS.md`, and the buffer is named in `03-plan/BUILD-PLAN.md` |
| README tells a fresh user what to do next | Pass |

## Disclosed limitation 1: two units are sized from a description, not from measurement

W8-CONGRUENCE and W9-ONBOARDING carry no reliable estimate yet. Their scope comes from v1 section 1.6, and the audit has already shown v1 to be pessimistic about this codebase. That is why W0-AUDIT exists and why both units depend on it. **Their estimates in `BUILD-PLAN.md` should be treated as placeholders until the gap map lands on 5 September.** If either turns out much larger than assumed, W9 is the named buffer and drops to post-cutover.

## Disclosed limitation 2: the shadow and canary units cannot be fully specified from outside production

W11-SHADOW and W12-CANARY depend on production behaviour, buyer endpoints and real traffic that could not be inspected from the audit environment. Their acceptance criteria are correct in shape but will need concrete thresholds from `docs/PRODUCTION-CUTOVER-RUNBOOK.md` and the first-supplier manifest when W10-GATEC assembles them. This is a `NEEDS-CHECK-NONBLOCKING`, owned by W10, not a gap in the plan.

## One thing the reviewer wants on the record

The largest risk in this pack is not technical. It is that twelve days of activation work sits behind a status migration that touches 138 code sites and every connector trigger, and that the migration is the one place where a silent failure produces wrong money rather than a loud error. W1-FLAGS exists solely to make that migration safe. It is not overhead and it must not be skipped to save a day.

## AgentOS control-plane review, 5 September 2026

PASS conditions added:
- explicit discovery approval recorded
- DNC remains enabled and Gate C evidence retained
- no requirement for Nick to paste wave prompts
- Bossman owns persistent orchestration
- Hermes Kanban and repo state are durable sources, Buzz/WhatsApp are communication surfaces
- `buzz_guard` is not widened
- only genuine human-authority actions interrupt Nick
