# Acceptance matrix

| Unit | Goal predicate | Acceptance | Evaluator | Human |
|---|---|---|---|---|
| W0-AUDIT | `node forge-pack/scripts/check-gap-map.mjs` | GAP-MAP cites paths and hours | evaluator | no |
| W1-FLAGS | `npx vitest run server/test/leadFlags.test.js && npm run gate` | A1 | evaluator-data | no |
| W2-STATUS | `npx vitest run server/test/leadStatus.test.js server/test/statusMigration.test.js && npm run gate` | A1, A6, A7 | evaluator-data | no |
| W3-UI-STATUS | `npm run gate && node forge-pack/scripts/check-status-vocabulary.mjs` | A9 | evaluator | no |
| W4-REAPER | `npx vitest run server/test/reapStuckLeads.test.js && npm run gate` | A2, A3 | evaluator-security | no |
| W5-EMPTY-STATES | `npm run gate && npx vitest run client/src/components/overview` | A8 | evaluator-ux | no |
| W6-FIXTURES | `npx vitest run server/test/fixtureOutcomes.test.js` | A3, A6 | evaluator | only if rules cannot be extracted |
| W7-INVARIANTS | `npx vitest run server/test/capRace.test.js server/test/idempotency.test.js && npm run gate` | A4, A5 | evaluator-security | no |
| W8-CONGRUENCE | `npm run gate && node forge-pack/scripts/check-gap-map.mjs --closed` | GAP-MAP P0 closure | evaluator-ux | no |
| W9-ONBOARDING | `npx vitest run server/test/buyerOnboarding.test.js && npm run gate` | A10 | evaluator-security | no |
| W10-GATEC | `node forge-pack/scripts/check-gate-c-packet.mjs` | A11 | evaluator-security | packet delivered |
| W11-SHADOW | `node forge-pack/scripts/check-shadow-clean.mjs` | A12 partial | evaluator-data | no |
| W12-CANARY | human sign-off recorded with evidence links | A12 | human | **required** |
| W13-OFFSITE | restore from the off-site copy boots the app image | R-OPS-06 | evaluator-security | provider and credential |
