# Production live URL gate

This packet covers the remaining production actions for the Hostinger VPS. It
does not itself authorize deployment, proxy changes, certificate issuance,
production data writes, or a live third-party call. Follow `docs/HUMAN-GATES.md`.

## Known production shape

- VPS: `2.25.138.44`, login user `dashflo`
- Checkout: `/opt/apps/dashflo`
- Docker Compose application: `dashflo-app`
- PostgreSQL: `dashflo-db`, database `dashflo_staging`
- Internal listener: `127.0.0.1:4000`
- Reverse proxy: nginx, current site `/etc/nginx/sites-available/dashflo`
- Marketing: `https://dashflo.io` and `https://www.dashflo.io`
- Final application: `https://app.dashflo.io`
- Supplier API: `https://api.dashflo.io`
- Documentation: `https://docs.dashflo.io`

Verify each record before certificate work:

```text
dig +short dashflo.io A
dig +short app.dashflo.io A
dig +short api.dashflo.io A
dig +short docs.dashflo.io A
```

Each application/API host must resolve to `2.25.138.44` before its certificate
work. As observed on 16 August 2026, the app record was absent; the required
record is `A app.dashflo.io 2.25.138.44`.

## Environment

Set in `/opt/apps/dashflo/server/.env` without printing values:

```text
PUBLIC_BASE_URL=https://app.dashflo.io
PUBLIC_API_BASE_URL=https://api.dashflo.io
ALLOWED_ORIGINS=https://dashflo.io,https://app.dashflo.io
BASE44_APP_ID=<source app id>
BASE44_MIGRATE_SECRET=<matching Base44 deployment secret>
BASE44_SYNC_ENABLED=1
```

The Compose service reads `server/.env`. Keep `PUBLIC_BASE_URL` on the existing
proven app origin until app DNS, TLS, login and callbacks pass. During the
transition, allow both application origins. Recreate the application container
after changing the file. Never put an actual credential in this document or a
shell history line.

## API host and TLS

Repository template: `deploy/nginx/api.dashflo.io.conf`.

The nginx host must proxy `https://api.dashflo.io/*` to
`http://127.0.0.1:4000`. The Docker port remains loopback-only and must not be
opened publicly. Issue a Let's Encrypt certificate for `api.dashflo.io`, install
the template, then run:

```text
sudo nginx -t
sudo systemctl reload nginx
```

Do not disturb the existing marketing or documentation blocks. Scoped
passwordless sudo for nginx, certbot, and systemctl was requested but was still
unavailable at the last check.

The app-host template is `deploy/nginx/app.dashflo.io.conf`. Activate it only
after the A record resolves and a hostname-valid certificate exists. Verify the
application, login, Settings and OAuth redirects on the new host before changing
`PUBLIC_BASE_URL`; only then can the apex be freed for the marketing site.

## Six-hour sync schedule

Merge `deploy/cron/base44-sync.cron` into the `dashflo` user's crontab. Do not
replace unrelated cron entries. The schedule is explicitly UTC at 00:00, 06:00,
12:00, and 18:00. It runs the CLI inside the existing application container,
which uses the same engine and database advisory lock as the owner manual
button.

Verify after installation:

```text
crontab -l
cd /opt/apps/dashflo
docker compose exec -T app node scripts/base44-sync.mjs ping
docker compose exec -T app node scripts/base44-sync.mjs sync --trigger manual
docker compose exec -T app node scripts/base44-sync.mjs status
```

Do not expose the migration secret in command output. The CLI deliberately
reports only whether it is configured.

## Public API verification

Read-only reachability checks:

```text
curl -sS https://api.dashflo.io/api/health
openssl s_client -connect api.dashflo.io:443 -servername api.dashflo.io
```

Acceptance evidence required before calling the supplier API ready:

1. DNS resolves to `2.25.138.44`.
2. Certificate hostname and chain validate for `api.dashflo.io`.
3. `/api/health` reaches `dashflo-app` through nginx.
4. Missing and invalid `X-API-KEY` requests are rejected without persistence.
5. An existing valid test/supplier key authenticates unchanged.
6. A controlled payload with `lead_route=test` is persisted but not delivered,
   sold, billed, or sent to a third party.
7. The resulting non-secret lead ID, supplier attribution, and API key usage
   increment are verified in PostgreSQL.
8. Nginx and application logs contain no header or credential value.

The controlled POST is a production data mutation and requires explicit Gate C
approval. Do not invent or rotate a key for the test. If a safe existing key is
not available, stop after the invalid-key check and report the boundary.

## Cutover remains separate

Installing TLS and the timer does not authorize final cutover. Freeze Base44,
final delta, final reconciliation, supplier traffic switch, timer removal, and
Base44 retirement follow the controlled sequence in `docs/BASE44-BOUNDARY.md`.
