# LIVE URL GATE

Status: OPEN, waiting on human action only

Date: 15 August 2026

Branch: `claude/dashflo-production-cutover-e1tgel`

This document contains only the actions a human must take. Everything on the
engineering side that does not depend on the domain is done or in progress and
continues without this gate. No credential value is requested here, and none
should ever be pasted into chat, an issue, a commit or a fixture.

Scope of what this unlocks: an authenticated staging deployment with a separate
database containing no real leads, banking records or billing records, and all
outbound integrations disabled. It does not authorise cutover, live delivery,
money movement or production data migration. Those remain Gate C.

## 1. Hosting destination required

One decision, then one set of credentials.

DashFlo is a single Node process serving both an API and the built client from
one origin, plus PostgreSQL. It is not serverless and it holds a durable receipt
table with worker leases, so it needs a persistent host with a real filesystem
and a long lived process, not an edge function runtime.

| Option | Fit | Note |
|---|---|---|
| A VPS you control, with Plesk or plain nginx | Best fit | Matches the current design exactly. One host, one Node process, one PostgreSQL. |
| A managed container host with a managed PostgreSQL | Workable | Needs persistent volume for `UPLOAD_DIR` or an object store, which is currently a local path. |
| Serverless or edge | Not suitable | Receipt leasing and background claiming assume a long lived process. |

DECISION REQUIRED: name the host. If a Plesk server already exists, provide
deployment access to it. Recommendation is option A, because it is what the
application already assumes and it adds no new failure modes before cutover.

## 2. Server requirements

Measured against what this branch actually runs.

- Node.js 22.x. Local verification ran on v22.23.1.
- npm 10.x. Local verification ran on 10.9.8.
- PostgreSQL 16. The durable receipt schema uses `BIGSERIAL`, a partial unique
  index and a table level `CHECK` constraint. Verified against PostgreSQL 16.
- 2 vCPU and 4 GB RAM is comfortable for the stated load. Observed peak
  requirement is 180 leads per day, which is small. The headroom is for the
  client build, not for request volume.
- 20 GB disk to start. The client build alone produces about 3.6 MB of assets;
  the rest is PostgreSQL, uploads and backups.
- Outbound network may stay closed for staging. Every business integration is
  disabled in this deployment, so nothing legitimately calls out.
- Inbound TCP 443 and 80. Port 80 only to serve the ACME challenge and redirect.
- The Node process must run under a supervisor that restarts it. systemd on
  Linux. The local instance uses a launchd agent, `com.legenex.dashflo.server`,
  which is the same idea and is not portable to the server.

Two things this deployment must NOT be given:

- Access to the `dashos` database, or to any dump of it.
- Any live integration credential. See section 4.

## 3. Exact DNS records

Replace `203.0.113.10` with the IPv4 address of the chosen host, and
`2001:db8::10` with its IPv6 address if it has one. Everything else is literal.

Apex and subdomains, A records:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `dashflo.co` | `203.0.113.10` | 300 |
| A | `api.dashflo.co` | `203.0.113.10` | 300 |
| A | `progress.dashflo.co` | `203.0.113.10` | 300 |
| A | `www.dashflo.co` | `203.0.113.10` | 300 |

If the host has IPv6, add the matching AAAA records. Do not add an AAAA record
unless the host actually answers on IPv6, because a published AAAA that does not
serve produces intermittent failures that look like an application fault.

| Type | Name | Value | TTL |
|---|---|---|---|
| AAAA | `dashflo.co` | `2001:db8::10` | 300 |
| AAAA | `api.dashflo.co` | `2001:db8::10` | 300 |
| AAAA | `progress.dashflo.co` | `2001:db8::10` | 300 |
| AAAA | `www.dashflo.co` | `2001:db8::10` | 300 |

Certificate authority pinning, one record, recommended:

| Type | Name | Value | TTL |
|---|---|---|---|
| CAA | `dashflo.co` | `0 issue "letsencrypt.org"` | 3600 |

Notes that matter:

- TTL 300 during setup so a mistake is cheap to correct. Raise to 3600 after the
  external acceptance tests in section 7 pass.
- Use A records rather than CNAME for the three service hosts. A CNAME at the
  apex is not valid in plain DNS, and keeping all four consistent avoids one
  host resolving differently from the others.
- Do not point anything at the operator workstation. The local instance at
  `http://localhost:4000` must never be exposed publicly, through DNS or a
  tunnel. It is attached to the real `dashos` database.
- No mail records are required by DashFlo. If `SMTP_HOST` is later pointed at a
  provider that sends as `dashflo.co`, that provider's SPF and DKIM records are
  needed then, not now.

## 4. Environment variable names required

Names only. Values go directly into the server's secret mechanism, never into
chat, a spreadsheet, an issue, a commit or a fixture.

Required for staging to start at all. Startup refuses to boot without these in
production mode:

| Name | Note |
|---|---|
| `NODE_ENV` | `production`. Not a secret. |
| `PORT` | Not a secret. The reverse proxy forwards to it. |
| `PUBLIC_BASE_URL` | Must be an https URL. Non loopback hosts are refused over plain http. |
| `JWT_SECRET` | New value, minimum 32 characters, unique to this environment. Startup rejects the old development fallback and anything placeholder shaped. |
| `PGHOST` | |
| `PGPORT` | |
| `PGUSER` | |
| `PGPASSWORD` | Startup rejects the literal default `postgres`. |
| `PGDATABASE` | Must name the staging database, never `dashos`. |
| `PGSSL` | |
| `ALLOWED_ORIGINS` | The staging origins only. |

Required by features that are already built and fail closed without them:

| Name | Note |
|---|---|
| `DNC_HASH_KEY` | Global do-not-contact hashing. No default; the DNC surface returns 503 without it. Read the rotation warning below before setting it. |
| `MIGRATE_SOURCE_SECRET` | New value. The previous one is in git history and its endpoint can stream every entity. Set it, or leave it unset so the endpoint refuses everything. |
| `CLIENT_DIST` | Path to the built client, if not the default. Not a secret. |
| `UPLOAD_DIR` | Persistent path. Not a secret. |
| `OWNER_BOOTSTRAP_TOKEN` | Only if the first owner is bootstrapped by token rather than by first registration. |

Deliberately left UNSET for staging, because setting them enables outbound calls
this gate does not authorise:

`LEADBYTE_API_KEY`, `LEADBYTE_BASE_URL`, `META_ACCESS_TOKEN`,
`TRUSTEDFORM_API_KEY`, `HLR_API_KEY`, `HLR_BASE_URL`, `STRIPE_API_KEY`,
`MERCURY_API_KEY`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_ACCESS_TOKEN`,
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`, `GOOGLE_CLIENT_EMAIL`,
`GOOGLE_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

Read before setting `DNC_HASH_KEY`: every suppression is stored as an HMAC under
this key and the raw contacts are deliberately not kept. Rotating it later
invalidates the entire list and means rebuilding it from its original sources.
Decide the key management approach before the list is populated, not after. Use
a different value in staging than in production, and expect the staging list to
be discarded.

## 5. TLS setup and verification

Setup, once DNS from section 3 resolves:

1. Confirm propagation before requesting a certificate. A failed ACME challenge
   counts against rate limits.
   ```
   dig +short dashflo.co A
   dig +short api.dashflo.co A
   dig +short progress.dashflo.co A
   dig +short www.dashflo.co A
   ```
   All four must return the host address.

2. Issue one certificate covering all four names, so a single renewal keeps them
   in step.
   ```
   certbot --nginx \
     -d dashflo.co -d www.dashflo.co \
     -d api.dashflo.co -d progress.dashflo.co
   ```
   Under Plesk, use Let's Encrypt in the panel and tick all four names.

3. Force the redirect from http to https on all four names, and confirm port 80
   serves only the redirect and the ACME challenge path.

4. Confirm automatic renewal is armed.
   ```
   certbot renew --dry-run
   systemctl list-timers | grep certbot
   ```

Verification, all four must pass before section 7 begins:

```
for h in dashflo.co www.dashflo.co api.dashflo.co progress.dashflo.co; do
  echo "== $h"
  curl -sSI "https://$h" | head -1
  echo | openssl s_client -servername "$h" -connect "$h":443 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates
done
```

Expected: a 2xx or 3xx status line, an issuer that is the chosen CA, a validity
window that covers today, and a subject or SAN set that includes the host being
tested. A certificate that covers only the apex is a misissue, not a partial
success.

Also confirm the http to https redirect:

```
curl -sSI http://dashflo.co | head -1
```

Expected: `HTTP/1.1 301 Moved Permanently`.

## 6. Deployment and rollback

### Deploy

1. Record the commit being deployed. `git rev-parse HEAD` on the branch.
2. Create the staging database. It must be empty and must not be named `dashos`.
3. Set the environment variables from section 4 in the server's secret
   mechanism. Do not write them into a file in the repository.
4. Install with the lockfile, never a loose install:
   ```
   npm ci
   npm --prefix server ci
   npm --prefix client ci
   ```
5. Build the client: `npm run build`.
6. Run the gate on the deployment host: `npm run gate`. All seven steps must
   pass. This is what proves the artifact on the machine that will serve it.
7. Run migrations against the staging database.
8. Start under the supervisor and confirm the process stays up across a restart.
9. Run the external acceptance tests in section 7.

### Rollback

Rollback is a redeploy of the previous commit, not a database restore, because
this deployment is additive and holds no data anyone depends on.

1. `git checkout <previous commit>` and repeat steps 4 through 8.
2. If the failure is configuration rather than code, correct the environment and
   restart. The startup checks refuse to boot on unsafe configuration, so a
   process that will not start is usually telling you exactly what is wrong and
   is safer than one that starts wrongly.
3. If the staging database is in a bad state, drop and recreate it. It contains
   no real leads, banking records or billing records, so it is disposable by
   design. Never point the rollback at `dashos`.
4. Kill switch: stop the supervised process. Nothing else is running, no traffic
   is being delivered to buyers, and no money moves, so stopping is complete.

Rollback for the domain itself is to remove the A records. Keep TTL at 300 until
section 7 passes so this stays cheap.

## 7. Final external acceptance tests

Run from a machine that is not the server, so the result reflects what the
public sees. Every one of these must pass before this gate is closed.

Reachability and identity:

1. `https://dashflo.co` returns 200 with valid TLS and renders DashFlo.
2. `https://api.dashflo.co/api/health` returns 200 and the safe health response.
3. `https://progress.dashflo.co` returns a response and refuses unauthenticated
   access outside its login flow.
4. `https://www.dashflo.co` redirects to the apex.
5. `http://` on all four names redirects to `https://`.

Authentication and authorization, the point of an authenticated staging:

6. The application is not anonymously usable. An unauthenticated operator route
   is refused, not rendered.
7. An anonymous call to a non-allowlisted backend function returns 401.
8. An anonymous call to the function index returns 401.
9. An anonymous entity read returns 401.
10. `migrateSource` with the previously committed secret returns 403.

Boundaries:

11. No retired host appears in any redirect, HTML, JavaScript bundle, API
    response, cookie or link. `server/test/retiredHosts.test.js` covers the
    source; this checks the served artifact.
12. No Base44 request is made while loading or using the application. Check the
    browser network panel across a full page load and a login.
13. The database the staging instance is connected to is the staging database.
    Confirm by name, not by assumption.

Integrations remain disabled:

14. Every variable in the "deliberately left UNSET" list of section 4 is unset
    on the running process.
15. No lead can be delivered to a buyer, no message can be sent, no conversion
    event can be emitted and no accounting or bank call can be made, because
    the credentials for all of them are absent.

## What is still true regardless of this gate

- The application is verified working at `http://localhost:4000`, serving 200 on
  both `/` and `/api/health`.
- The gate is green on this branch: 776 tests pass with none skipped, across
  seven steps.
- Moving to a real domain is a configuration change, not a code change. All URLs
  already resolve through `server/src/lib/urls.js` and `client/src/lib/urls.js`,
  which have no remote host default and fall back to loopback rather than to
  somebody else's system.

## Known gap this gate does not close

`/api/health` currently returns `{"status":"ok"}` and nothing more. The
requirement is that health and readiness distinguish process health, database
health and backlog health. That is task O2 and it is not built. Acceptance test
2 above therefore proves reachability only, not readiness. Do not read a 200
from it as evidence that the database or the receipt backlog is healthy.

## Decision required

1. Confirm `dashflo.co` is the intended domain, or name the domain you already
   control and it will be targeted instead.
2. Name the hosting destination and provide deployment access.
3. Confirm the staging database may be created on the chosen host.

A temporary tunnel is not used as the final live URL without separate approval,
and the existing localhost instance is never exposed, because it is attached to
the real `dashos` database.
