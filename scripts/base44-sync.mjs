#!/usr/bin/env node
// Base44 to DashFlo migration sync, command line entry point.
//
// This is the ONLY scheduled entry point. The owner facing manual trigger in
// the application calls the same `Base44Sync.run()` and the same
// `reconcile()`, so there is one implementation and a scheduled run and a
// manual run cannot drift apart.
//
// Usage:
//   node scripts/base44-sync.mjs sync        [--entity Name] [--trigger scheduled|manual]
//   node scripts/base44-sync.mjs status
//   node scripts/base44-sync.mjs reconcile   [--entity Name] [--json]
//   node scripts/base44-sync.mjs ping
//
// Configuration, all from the environment:
//   BASE44_APP_ID           the source app id
//   BASE44_MIGRATE_SECRET   shared secret for the migrateSource function
//   BASE44_SYNC_ENABLED     0 to disable the scheduled run after cutover
//   BASE44_BASE_URL         optional override of https://<appId>.base44.app
//
// Exit codes: 0 success or skipped, 1 partial, 2 failed. The scheduler reads
// these, so "partial" is deliberately not success.

import process from 'node:process';

const args = process.argv.slice(2);
const command = args[0] || 'status';

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
}
const has = (name) => args.includes(`--${name}`);

const entity = flag('entity');
const entities = entity ? [entity] : null;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const { Base44Sync, syncStatus } = await import('../server/src/lib/base44Sync.js');
  const { Base44Source, base44ConfigFromEnv, isConfigured } = await import('../server/src/lib/base44Source.js');

  const cfg = base44ConfigFromEnv();

  if (command === 'ping') {
    const source = new Base44Source(cfg);
    // describe() never includes the secret itself.
    log(`source: ${JSON.stringify(source.describe())}`);
    if (!isConfigured(cfg)) {
      log('NOT CONFIGURED. Set BASE44_APP_ID and BASE44_MIGRATE_SECRET.');
      return 2;
    }
    const res = await source.ping();
    log(`ping ok=${res?.ok === true} configured=${res?.configured === true}`);
    return res?.ok ? 0 : 2;
  }

  if (command === 'status') {
    const status = await syncStatus({ limit: Number(flag('limit', 5)) });
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  if (command === 'reconcile') {
    const { reconcile } = await import('../server/src/lib/base44Reconcile.js');
    const report = await reconcile({ entities });
    if (has('json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      log(`reconciliation ${report.clean ? 'CLEAN' : 'HAS DIFFERENCES'}`);
      if (report.summary) {
        log(`entities=${report.summary.entities} missingLocally=${report.summary.missingLocally} `
          + `localOnly=${report.summary.localOnly} stale=${report.summary.stale} `
          + `conflicts=${report.summary.conflicts} fieldMismatches=${report.summary.importantFieldMismatches} `
          + `relationshipMismatches=${report.summary.relationshipMismatches} errors=${report.summary.withErrors}`);
      }
      for (const e of report.entities || []) {
        if (e.error) { log(`  ${e.entity}: ERROR ${e.error}`); continue; }
        if (e.onlyInBase44Count || e.onlyInDashFloCount || e.staleInDashFloCount || e.conflicts) {
          log(`  ${e.entity}: source=${e.sourceCount} local=${e.localCount} `
            + `onlyBase44=${e.onlyInBase44Count} onlyDashFlo=${e.onlyInDashFloCount} `
            + `stale=${e.staleInDashFloCount} conflicts=${e.conflicts}`);
        }
      }
    }
    return report.clean ? 0 : 1;
  }

  if (command === 'sync') {
    const trigger = String(flag('trigger', 'scheduled'));
    const sync = new Base44Sync({ cfg });
    const res = await sync.run({ trigger, entities });

    if (res.status === 'skipped') {
      log(`sync skipped: ${res.reason}`);
      return 0;
    }

    log(`sync ${res.status} run=${res.runId}`);
    const t = res.totals || {};
    log(`inspected=${t.inspected} created=${t.created} updated=${t.updated} `
      + `skipped=${t.skipped} conflicted=${t.conflicted} failed=${t.failed}`);

    for (const e of res.entities || []) {
      if (e.status !== 'success' || e.created || e.updated || e.conflicted) {
        log(`  ${e.entity}: ${e.status} created=${e.created} updated=${e.updated} `
          + `conflicted=${e.conflicted} failed=${e.failed}${e.error ? ` error=${e.error}` : ''}`);
      }
    }

    if (res.status === 'success') return 0;
    return res.status === 'partial' ? 1 : 2;
  }

  console.error(`Unknown command: ${command}`);
  return 2;
}

main()
  .then(async (code) => {
    const { pool } = await import('../server/src/db/pool.js');
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    // Never print the error object wholesale: a thrown request error can carry
    // the request body, and the request body carries the shared secret.
    log(`FATAL: ${err?.message || 'unknown error'}`);
    const { pool } = await import('../server/src/db/pool.js');
    await pool.end().catch(() => {});
    process.exit(2);
  });
