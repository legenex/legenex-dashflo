#!/usr/bin/env node
// Daily updater: code sync + full data refresh + 1:1 import.
//
// This is the scheduled (launchd) form of sync/updater-prompt.md. It runs:
//   1. node sync/sync.mjs --force          (pull upstream code, rebuild, push)
//   2. N parallel `claude -p` pulls        (re-extract every entity to JSON)
//   3. a safety gate                       (files parse + record count sane)
//   4. node sync/import-data.mjs --truncate (exact 1:1 mirror)
//   5. health check
//
// Self-logging to sync/state/daily-update.log — the launchd plist deliberately
// has NO StandardOutPath (launchd failing to reopen a fixed log file is the
// recurring EX_CONFIG(78) that has silently killed these agents before).
//
// Usage: node sync/daily-update.mjs [--no-code] [--no-data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STATE_DIR = path.join(HERE, 'state');
const EXPORT_DIR = path.join(STATE_DIR, 'import-export');
const LOG_FILE = path.join(STATE_DIR, 'daily-update.log');
const STAMP_FILE = path.join(STATE_DIR, 'last-data-refresh.json');

const APP_ID = process.env.DASHOS_SOURCE_APP_ID || '6a4957e7b03e9b10c170d29e';
const NODE_BIN = process.execPath;
const HEALTH_URL = process.env.DASHOS_HEALTH_URL || 'http://localhost:4000/api/health';

// A pull that collapses to a fraction of the previous mirror means the source
// call failed part-way. Importing that with --truncate would wipe good rows, so
// we refuse to import below this ratio of the last successful total.
const MIN_TOTAL_RATIO = 0.9;
const GROUPS = 4;              // parallel claude processes for ordinary entities
const PULL_TIMEOUT_MS = 30 * 60 * 1000;
const BIG_PULL_TIMEOUT_MS = 60 * 60 * 1000;
// Entities too large to pull in one page-through; each needs a partitioned pull.
const BIG_ENTITIES = new Set(['MetaSyncRun']);

const args = new Set(process.argv.slice(2));
const flag = (f) => args.has(f);

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// Entity list comes from the generated schemas, so entities added upstream are
// picked up automatically instead of drifting out of a hardcoded list.
async function entityNames() {
  const mod = await import(path.join(ROOT, 'server/src/schemas/index.js'));
  return mod.entityNames.filter((n) => n !== 'User');
}

const PULL_TOOLS = ['ToolSearch', 'mcp__claude_ai_Base44__query_entities', 'Write', 'Read', 'Bash'];

function groupPrompt(list) {
  return `Extract CURRENT data from a source app to JSON files (overwrite existing). Work SEQUENTIALLY: pull one entity, write its file, next. Do NOT spawn subagents or background tasks.

SOURCE APP ID: \`${APP_ID}\`
OUTPUT DIR: \`${EXPORT_DIR}/\`

STEP 1: Load the tool: ToolSearch \`select:mcp__claude_ai_Base44__query_entities\`. Params \`{appId, entityName, limit(max 500), skip, sort}\`, returns \`{entities:[...], count}\`.

STEP 2: For EACH entity below, pull ALL records and OVERWRITE \`<Entity>.json\`:
${list.join(' ')}

For each: call with \`limit:500, skip:0, sort:"-created_date"\` and NO \`fields\` param — every field must be kept, including id/created_date/updated_date/created_by. If a page returns exactly 500, paginate \`skip += 500\` until a page returns fewer than 500; concatenate; dedupe by \`id\`. Write the full JSON array with the Write tool immediately (an entity with no records → \`[]\`). Some entities have 1,000+ records — page through all of them, never truncate.

STEP 3: Report one line per entity as \`Entity: count\`. Do not print record contents.`;
}

function bigPrompt(name) {
  return `Extract ALL records of ONE very large entity to a JSON file. It has ~100,000+ records and the API's \`skip\` caps at 10,000, so you MUST partition.

SOURCE APP ID: \`${APP_ID}\`
ENTITY: \`${name}\`
OUTPUT FILE: \`${path.join(EXPORT_DIR, name + '.json')}\`

STEP 1: Load the tool: ToolSearch \`select:mcp__claude_ai_Base44__query_entities\`. Params \`{appId, entityName, query, limit(max 500), skip, sort}\`.

STEP 2 — Partition by \`ad_account_id\` (~39 accounts, each partition well under the 10,000 skip cap):
1. Get the partition list from \`SupplierAdAccount\` (\`query_entities entityName:"SupplierAdAccount", limit:500\`) and use its \`ad_account_id\` values.
2. For EACH ad_account_id: \`query_entities\` with \`query: {"ad_account_id": "<id>"}, limit:500, skip:0, sort:"-created_date"\`, paginating \`skip += 500\` until a page returns < 500. Keep ALL fields (NO \`fields\` param).
3. Concatenate every account's records and DEDUPE by \`id\`.

CONTEXT: this is ~75 MB of JSON — do NOT hold it inline. Write each page to a scratch file under \`${path.join(os.tmpdir(), 'dashos-' + name.toLowerCase())}/\` and merge with a python script at the end. Never truncate or sample.

NOTE: \`created_date\` range filters do NOT work on this entity (ISODate); only scalar equality filters like ad_account_id work.

STEP 3 — Safety: back up the existing file to \`<file>.bak\` first. The new file must be a valid JSON array with unique ids and at least as many records as the backup. If your merged count is LOWER than the backup's, do NOT overwrite — report the discrepancy.

STEP 4: Report the final record count, partitions covered, and the newest \`created_date\`. Do not print record contents.`;
}

async function claudePull(label, prompt, timeout) {
  const started = Date.now();
  log(`  [${label}] pull starting`);
  const res = await run('claude', [
    '-p', prompt,
    '--output-format', 'text',
    '--allowedTools', ...PULL_TOOLS,
  ], { cwd: os.tmpdir(), timeout, env: { ...process.env, CLAUDE_NOTIFIER_DISABLE: '1' } });
  const secs = Math.round((Date.now() - started) / 1000);
  if (!res.ok) {
    log(`  [${label}] FAILED after ${secs}s: ${(res.stderr || res.err?.message || '').slice(0, 300)}`);
    return false;
  }
  const tail = res.stdout.trim().split('\n').slice(-12).join(' | ').slice(0, 600);
  log(`  [${label}] done in ${secs}s: ${tail}`);
  return true;
}

// Every file must parse as an array, and the grand total must not have collapsed
// versus the last successful refresh — otherwise --truncate would destroy data.
function inspectExports() {
  const files = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json'))
    : [];
  const bad = [];
  let total = 0;
  const counts = {};
  for (const f of files) {
    const name = path.basename(f, '.json');
    try {
      const d = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, f), 'utf8'));
      if (!Array.isArray(d)) { bad.push(`${name}: not an array`); continue; }
      counts[name] = d.length;
      total += d.length;
    } catch (e) {
      bad.push(`${name}: ${e.message.slice(0, 80)}`);
    }
  }
  return { files: files.length, total, counts, bad };
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')); } catch { return null; }
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  log('=== daily update starting ===');
  let failed = false;

  // ---- 1. code -------------------------------------------------------------
  if (flag('--no-code')) {
    log('[code] skipped (--no-code)');
  } else {
    log('[code] running sync.mjs --force');
    const res = await run(NODE_BIN, [path.join(HERE, 'sync.mjs'), '--force'], { timeout: 45 * 60 * 1000 });
    const tail = (res.stdout || '').trim().split('\n').slice(-6).join(' | ').slice(0, 700);
    if (res.ok) log(`[code] ok: ${tail}`);
    else { failed = true; log(`[code] FAILED (${res.code}): ${tail} ${(res.stderr || '').slice(0, 300)}`); }
  }

  // ---- 2. data pull --------------------------------------------------------
  if (flag('--no-data')) {
    log('[data] skipped (--no-data)');
  } else {
    const names = await entityNames();
    const big = names.filter((n) => BIG_ENTITIES.has(n));
    const rest = names.filter((n) => !BIG_ENTITIES.has(n));
    const groups = Array.from({ length: GROUPS }, () => []);
    rest.forEach((n, i) => groups[i % GROUPS].push(n));
    log(`[data] ${names.length} entities → ${GROUPS} groups + ${big.length} partitioned`);

    const jobs = [
      ...groups.filter((g) => g.length).map((g, i) => claudePull(`group${i + 1}`, groupPrompt(g), PULL_TIMEOUT_MS)),
      ...big.map((n) => claudePull(n, bigPrompt(n), BIG_PULL_TIMEOUT_MS)),
    ];
    const results = await Promise.all(jobs);
    const okCount = results.filter(Boolean).length;
    log(`[data] pulls complete: ${okCount}/${results.length} ok`);
    if (okCount < results.length) failed = true;
  }

  // ---- 3. safety gate ------------------------------------------------------
  const snap = inspectExports();
  log(`[gate] ${snap.files} files, ${snap.total} records`);
  if (snap.bad.length) {
    log(`[gate] ABORT — ${snap.bad.length} unreadable file(s): ${snap.bad.slice(0, 5).join('; ')}`);
    log('=== daily update finished WITH ERRORS (no import) ===');
    process.exit(1);
  }
  const prev = readStamp();
  if (prev?.total && snap.total < prev.total * MIN_TOTAL_RATIO) {
    log(`[gate] ABORT — record total collapsed: ${snap.total} < ${Math.round(prev.total * MIN_TOTAL_RATIO)} (${MIN_TOTAL_RATIO * 100}% of last ${prev.total}). Export dir left untouched; not importing.`);
    log('=== daily update finished WITH ERRORS (no import) ===');
    process.exit(1);
  }

  // ---- 4. import -----------------------------------------------------------
  if (flag('--dry-run')) {
    log('[import] skipped (--dry-run)');
  } else {
    log('[import] running import-data.mjs --truncate');
    const res = await run(NODE_BIN, [path.join(HERE, 'import-data.mjs'), '--truncate'], { timeout: 45 * 60 * 1000 });
    const totalLine = (res.stdout || '').split('\n').filter((l) => l.includes('total records imported')).join('');
    if (res.ok) {
      log(`[import] ok: ${totalLine.trim() || 'done'}`);
      fs.writeFileSync(STAMP_FILE, JSON.stringify({
        at: new Date().toISOString(), total: snap.total, counts: snap.counts,
      }, null, 2));
    } else {
      failed = true;
      log(`[import] FAILED (${res.code}): ${(res.stderr || '').slice(0, 400)}`);
    }
  }

  // ---- 5. verify -----------------------------------------------------------
  try {
    const code = execFileSync('curl', ['-s', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', HEALTH_URL], { encoding: 'utf8' }).trim();
    log(`[verify] health ${code}`);
    if (code !== '200') failed = true;
  } catch (e) {
    failed = true;
    log(`[verify] health check failed: ${e.message.slice(0, 200)}`);
  }

  log(failed ? '=== daily update finished WITH ERRORS ===' : '=== daily update finished OK ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
