# DashFlo production and Base44 migration boundary

Read this before changing deployment, synchronization, export, API keys, or
Base44 code. This file is the current migration handoff for future sessions.

## Authority and production architecture

DashFlo on the Hostinger VPS is the permanent application and source of truth.
Base44 remains live only as a temporary source of durable records during the
transition. Synchronization is one way: Base44 to DashFlo. There is no
DashFlo-to-Base44 path and no normal DashFlo request depends on Base44.

Production endpoints:

- Marketing: `https://dashflo.io` and `https://www.dashflo.io`
- Application: `https://app.dashflo.io`
- Supplier API: `https://api.dashflo.io`
- Documentation: `https://docs.dashflo.io`
- VPS: `2.24.130.44`
- Internal application listener: `127.0.0.1:4000`

The VPS checkout is `/opt/apps/dashflo`. Docker Compose runs `dashflo-app` and
PostgreSQL 16 (`dashflo-db`, database `dashflo_staging`). Nginx terminates TLS
and proxies public traffic to the loopback application port. The repository
template for the API host is `deploy/nginx/api.dashflo.io.conf`.

`PUBLIC_BASE_URL=https://app.dashflo.io` is the final application origin.
`PUBLIC_API_BASE_URL=https://api.dashflo.io` is the authoritative external API
origin. The latter is returned by `/api/auth/public-settings`, so endpoint,
copy, cURL, posting specifications, OAuth callbacks, and public docs use one
runtime value. Local development falls back to the browser origin or
`http://localhost:4000`.

Production deploys, proxy edits, certificate issuance, live third-party calls,
and production data writes require the approval recorded in
`docs/HUMAN-GATES.md`. Preparing code and read-only inspection do not.

## Temporary synchronization

The deterministic entry point is `scripts/base44-sync.mjs`. It talks only to
the read-only Base44 `migrateSource` function through HTTPS. Configuration:

- `BASE44_APP_ID`
- `BASE44_MIGRATE_SECRET`
- optional `BASE44_BASE_URL`
- `BASE44_SYNC_ENABLED=1` to allow scheduled runs
- optional timeout and retry settings documented in `server/.env.example`

There is no default secret. Base44 also has no literal fallback secret: its
`MIGRATE_SOURCE_SECRET` deployment secret must match. Missing configuration
fails closed. No secret value is logged.

The target schedule is UTC at 00:00, 06:00, 12:00, and 18:00. The user-cron
template is `deploy/cron/base44-sync.cron`. It executes the same
`Base44Sync.run()` used by the owner-only manual control in Settings, API Keys,
System Keys. PostgreSQL advisory lock `4471001` prevents overlap between manual
and scheduled runs. The cron `flock` is a second host-level guard.

First sync is a paged full import. Later clean runs query records whose
`updated_date` is at or beyond the durable per-entity watermark. The inclusive
cursor deliberately re-reads the boundary; fingerprints make that idempotent
and prevent records with equal timestamps from being skipped. If an entity has
no reliable source delta, the full idempotent path remains available. A partial
entity pass does not advance its watermark.

Tables created by `server/src/db/base44SyncSchema.js`:

- `base44_sync_runs`: durable run result and totals
- `base44_sync_run_entities`: per-entity outcome and cursor
- `base44_sync_state`: last attempt, last success, watermark, failures
- `base44_record_provenance`: Base44 ID, DashFlo ID, source timestamp,
  fingerprint, local ownership, and conflict state

Base44 IDs are preserved. Records are never deleted because they disappeared
upstream. A pre-existing DashFlo row is adopted as DashFlo-owned and is never
silently overwritten. A record changed locally after import becomes sticky.
When both copies change it is reported as a conflict. Supplier, buyer, and
system credential fields plus runtime usage counters are import-once and are
never rewritten by later syncs. Runtime-owned counters and distribution audit
entities are excluded. `User` is never imported because authentication remains
DashFlo-owned. High-volume `MetaSyncRun` history is excluded from the repeating
delta but can be named explicitly for a one-time import and reconciliation.

Disable automatic sync after cutover by setting `BASE44_SYNC_ENABLED=0` and
removing the cron entry. History and provenance remain in PostgreSQL.

The old local `sync/daily-update.mjs --no-code` mirror refresh is not the VPS
scheduler. Never run the legacy code pull (`sync/sync.mjs`) and never install
the old LaunchAgent scheduler. Base44 application code is not synchronized.

## Reconciliation

Run:

```text
node scripts/base44-sync.mjs reconcile --json
```

or use the owner-only Reconcile button in Settings. The report compares counts,
IDs present on only one side, source timestamps newer than provenance, conflict
flags, allowlisted important fields, relationships, and lead status counts.
Samples are bounded and credential fields, raw connector blobs, and cleartext
keys are never included. Count equality alone is not treated as proof.

## API keys and Meta credentials

Settings is named API Keys and has three categories:

1. System Keys: owner-only platform credentials
2. Supplier Keys: operational `X-API-KEY` credentials tied to suppliers
3. Buyer Keys: optional credentials tied to buyers

Supplier authentication remains `X-API-KEY: <supplier-key>`. HTTP Basic may
remain as a compatibility path where the intake handler supports it. Supplier
gateway keys are not LeadByte `X_KEY` credentials. Imported raw supplier values
are used once to derive the DashFlo hash without changing the operational key.
Later syncs cannot replace key material or usage counters.

Meta App ID is `SystemKey.client_id`; Meta App Secret is `SystemKey.secret` on
the active Meta provider row. SystemKey is the only writable authoritative
location. Existing `IntegrationConfig(name=meta_app)` and environment values
are read-only compatibility fallbacks until migration completes. The Data
Sources screen shows connection, accounts, mappings, last sync, result, and
health, and points the owner to API Keys when credentials are missing.

The generic entity route never exposes `SystemKey`, `BuyerApiKey`, or
`KeyAuditEvent`. It strips supplier raw key/hash and the legacy
`Buyer.buyer_api_key`. Credential mutations use reviewed backend functions and
write audit events without credential values.

## Base44 encrypted migration export

Base44 has a separate owner-only `systemMigrationExport`. It is not the
ordinary export. The ordinary export remains server-side redacted. The
migration export encrypts each chunk before response with AES-256-GCM and a
PBKDF2-SHA256 passphrase-derived key (600,000 iterations). It preserves IDs,
relationships, timestamps, configuration, and durable history.

The encrypted payload includes, where present: supplier cleartext API keys,
SystemKey secret/client ID, BuyerApiKey key and legacy buyer key, Meta durable
tokens, IntegrationConfig config, LeadByte connector headers/target, pull
source credentials, API connector tokens/headers/target, webhook credentials,
inbound token hashes, LeadSource webhook keys, SubDelivery URLs, and BotConfig
keys. Secret-bearing chunks create KeyAuditEvent records.

It drops `meta_oauth_state` records plus user password/hash/session/refresh
fields and invitation tokens. It does not carry cookies, CSRF state, login
state, or other ephemeral authentication material. No actual credential belongs
in this repository or in a migration report.

## Controlled cutover

Do not perform cutover automatically.

1. Deploy and enable the six-hour Base44-to-DashFlo sync.
2. Validate DNS, TLS, reverse proxy, and the public API hostname.
3. Produce and securely store the owner encrypted migration export.
4. Reconcile IDs, relationships, statuses, important fields, and secrets.
5. Run a controlled test lead with `lead_route=test` so no buyer delivery fires.
6. Freeze relevant Base44 writes at the agreed time.
7. Run one final manual delta and reconcile again.
8. Confirm supplier and buyer key values were not changed.
9. Move supplier traffic to `https://api.dashflo.io/functions/leads`.
10. Verify valid and invalid authentication, persistence, attribution, usage,
    and safe logs through the public hostname.
11. Disable the timer, retain history, and keep Base44 read-only for reference.

## Current deployment gaps

As observed on 16 August 2026, `app.dashflo.io` does not yet have DNS. Add an A
record for `app.dashflo.io` pointing to `2.24.130.44`, then issue its certificate
and activate `deploy/nginx/app.dashflo.io.conf`. Keep `PUBLIC_BASE_URL` on the
currently proven application origin until that succeeds; include both origins
in `ALLOWED_ORIGINS` during the transition. Host-only sessions do not transfer
between the apex and app host, so operators should expect to sign in once on
the new host. The API and app nginx/certificate work requires scoped sudo,
which was unavailable to the deployment user at the last check. Do not mark a
hostname READY until DNS, hostname-valid TLS, proxy health and login pass there.
