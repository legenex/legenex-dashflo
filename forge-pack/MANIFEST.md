# Manifest

| File | Why it exists | Consumed by |
|---|---|---|
| `CONTRACT.md` | Canonical product contract. Supersedes v1, v2, v2.1 | Every agent, first read |
| `00-intake/DISCOVERY.md` | Readiness assessment, readback, owner approval record | Orchestrator, auditors |
| `00-intake/AUDIT.md` | Verified findings from the 4 Sep repository clone | Every agent before assuming anything |
| `01-product/PROJECT.md` | Executive summary: problem, scope, cost of failure | Orchestrator, new agents |
| `01-product/REQUIREMENTS.md` | Stable requirement IDs with verification method | Builders, evaluator, traceability |
| `01-product/ACCEPTANCE.md` | Observable acceptance criteria | Evaluator |
| `01-product/DECISIONS.md` | Binding decisions D1 to D11, pointer to CONTRACT | All |
| `01-product/DEFERRED.md` | What is deliberately excluded and why | Anyone tempted to build it |
| `02-architecture/POINTERS.md` | Where the real architecture docs live in the repo | All |
| `02-architecture/RISKS.md` | Ranked risks with mitigation owners | Orchestrator |
| `03-plan/WORK-UNITS.yaml` | Machine-readable work graph. Execution source of truth | Orchestrator, builders |
| `03-plan/WORK-GRAPH.md` | Human view of the graph and dependencies | All |
| `03-plan/BUILD-PLAN.md` | Waves, critical path, bottleneck | Orchestrator |
| `03-plan/HUMAN-PATH.md` | Owner-only tasks and what they block | Nick, orchestrator |
| `03-plan/TRACEABILITY.md` | Requirement to unit to acceptance mapping | Evaluator |
| `04-prompts/WAVE-0*.md` | Paste-ready wave prompts | Whoever starts a session |
| `05-execution/EXECUTION-PROMPT.md` | The standing worker prompt | Every coding session |
| `05-execution/RALPH.md` | Outer loop across context windows | Orchestrator |
| `05-execution/EVALUATOR-LOOP.md` | Builder and evaluator separation | Evaluator |
| `05-execution/STALL-POLICY.md` | When to stop, what to write, what to do next | All |
| `06-qa/QUALITY-GATES.md` | Fast gate and full gate definitions | All |
| `06-qa/ACCEPTANCE-MATRIX.md` | Unit to predicate to evidence | Evaluator |
| `06-qa/PACK-REVIEW.md` | Adversarial self-review of this pack | Nick |
| `07-handoff/RUNBOOK.md` | How to run, resume, and hand off | All |
| `08-hosts/CLAUDE-CODE.md` | Claude Code specifics | Coding workers |
| `08-hosts/HERMES-BUZZ.md` | How Hermes and Buzz are wired to this pack | Orchestrator, Nick |
| `agents/*.md` | Role contracts mapped to Nick's named roster | All |
| `state/*.md` | Durable state so a fresh session resumes without chat | All |
| `scripts/*.mjs` | Real goal predicates referenced by work units | CI, builders |
