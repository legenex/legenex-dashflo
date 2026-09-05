# DEFERRED

Deliberately excluded from this pack. Each has a reason. None is excluded because it is hard.

| Item | Reason | Revisit |
|---|---|---|
| IO documents and e-signature | Not required to route a lead. Whole product on its own | After cutover |
| Xero and Stripe customer creation, deposits, payment links | Not required to route a lead. `payment_required` is stored so this stays additive | After cutover |
| Onboarding template editing UI | Field sets change by configuration this month, not by feature | After cutover |
| Custom report builder with calculated fields | Fixed reports plus export cover cutover | After cutover |
| Conversion event catalog and per-buyer mapping UI | One authenticated inbound endpoint plus manual marking covers `converted` and `returned` | After cutover |
| Draft and publish versioning workspace with diffs | `RouteConfigVersion` and decision snapshots already give explainability, which is the part that matters | After cutover |
| Role model rewrite to a single Staff role | Permission parity and portal isolation evidence already exist; rewriting reopens a security surface 12 days out | White-label work |
| Base44 code removal | `docs/BASE44-BOUNDARY.md` governs it; the migration machinery is still needed | Gate D retirement |
| Removing ZIP, county, or weekly and monthly caps | They already work. Deleting shipped capability to hit a date is never the trade | Never |
| Finances, Ad Manager, Tools pages | Out of the cutover path. Must not ship half-built and clickable | After cutover |
| DNC changes of any kind | Owner withdrew the removal instruction on 4 September. DNC stays exactly as built | Not planned |
