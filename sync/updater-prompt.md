# Daily Updater Prompt (code + data)

Run this prompt in a Claude Code session **on the Mac** (repo + Postgres are local)
that has the **claude.ai Base44 connector enabled**. Schedule it every 24h.

---

You are the daily updater for **Legenex DashOS** at `/Users/nickallen/Documents/Projects/Legenex DashOS`. Do all three steps, then report a short summary. Never print or commit secrets; `server/.env` and `sync/state/` are gitignored.

## STEP 1 — Code sync (track app updates + push to GitHub)
Run: `cd "/Users/nickallen/Documents/Projects/Legenex DashOS" && node sync/sync.mjs --force`
This pulls the source repo, transforms it into the standalone app, rebuilds the client, restarts the server, and auto-commits + pushes to `github.com/legenex/legenex-dashflo`.
- If the push is rejected for a secret, the transform already scrubs `sk_/rk_/pk_/whsec_` key patterns — re-run the redaction on the offending file, `git add -A`, amend/commit, and push again.
- If `curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/api/health` is not `200`, the launchd server agent may be in EX_CONFIG(78): reload it — `launchctl bootout gui/$(id -u)/com.legenex.dashos.server 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.legenex.dashos.server.plist` — and if it still fails, point its StandardOut/ErrorPath in that plist at a fresh filename and re-bootstrap.
- If Postgres is unreachable (`password authentication failed` / connection refused), the Homebrew Postgres may be stopped or a Docker container took port 5432. Ours runs on **5433**; ensure `brew services start postgresql@16` is running and `server/.env` has `PGPORT=5433`.

## STEP 2 — Data refresh (pull latest base44 data into local Postgres)
Source base44 app id: **`6a4957e7b03e9b10c170d29e`** (Legenex Dashboard).
1. Load the query tool: ToolSearch `select:mcp__claude_ai_Base44__query_entities`.
2. Spawn **4 parallel general-purpose sub-agents** (keeps the pull reliable and off your own context). Each pulls its entity group from the app and OVERWRITES `sync/state/import-export/<Entity>.json`. For every entity: `query_entities` with `limit:500, skip:0, sort:"-created_date"` (NO `fields` param — keep ALL fields incl id/created_date/updated_date/created_by); if a page returns exactly 500, paginate `skip += 500` until `< 500`; concatenate; dedupe by `id`; write the full JSON array with the Write tool (empty → `[]`). `Lead` has ~1,800+ records (page through all).
   - **Group A:** Lead Buyer Supplier Campaign ApiKey ApiConnector LeadByteConnector CustomField Counter AppSettings Brand Vertical Disposition CustomCalculation HlrSettings EmailValidationSettings IntegrationConfig FieldMapping
   - **Group B:** AdSpend AdSpendMapping BankTransaction BillingRun BillingLineItem BuyerPayment BuyerWallet WalletTransaction Invoice BuyerCplRule BuyerStateCpl SupplierStateCoverage SupplierSource SupplierPayout SupplierAdAccount StateStatus StateChangeEvent
   - **Group C:** Delivery SubDelivery DeliveryAttempt BidAttempt RouteGroup RouteMember RouteConfigVersion RouteDecisionTrace DestinationHealth CapCounter CapReservation DistributionAudit InboundWebhookRoute AdCreativeMeta MetaConnection MetaLeadFormMapping
   - **Group D:** ErrorLog AuditLog AuditFinding AuditRun NotificationEvent NotificationRule BenchmarkCriterion ImportTemplate PayloadTest ReferenceKey Report ResponseMapping ReturnRequest CertBackupStore ContractVersion Invitation BuyerOnboarding OnboardingEmailTemplate KnowledgeDoc BuyerFeedback LeadSource MetaSyncRun
3. After all 4 sub-agents finish, import: `cd "/Users/nickallen/Documents/Projects/Legenex DashOS" && node sync/import-data.mjs`
   (Upserts by id, preserves ids/dates, skips the `User` entity so local logins stay intact.)

## STEP 3 — Verify + report
- `curl http://localhost:4000/api/health` should be `200`.
- Report: code commit pushed (short hash) or "no code changes"; imported row counts for Lead / Buyer / AdSpend; and any warnings (staged function ports, failed push, agent errors).
