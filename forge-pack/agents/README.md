# Roles

Mapped to Nick's existing named roster rather than inventing a parallel one.

| File | Roster name | Used by |
|---|---|---|
| `orchestrator.md` | Bossman | Plan, waves, digests, gate packets |
| `builder.md` | Dexter | Every implementation unit |
| `evaluator.md` | Critic | Default evaluator |
| `evaluator-data.md` | Digit | W1, W2, W11. Money and migrations |
| `evaluator-security.md` | Critic in security mode | W4, W7, W9, W10, W13 |
| `evaluator-ux.md` | Picasso | W5, W8 |
| `integrator.md` | Archie | Shared files and merges |
| `researcher.md` | Sherlock | W0 and any bounded factual question |

One model per agent, no fallbacks, per the standing preference. Bugsy runs the QA suites inside the builder loop rather than as a separate role in this pack, because the repository gate already covers what a separate QA pass would do.
