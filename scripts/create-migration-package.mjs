#!/usr/bin/env node
// Owner Migration Package Exporter
//
// Creates a referentially complete, deterministic DashFlo migration package from
// Base44 (legenex-dashboard) data. Performs preflight validation before encryption.
//
// Usage (interactive, preferred for manual use):
//   node scripts/create-migration-package.mjs
//
// Usage (automation):
//   MIGRATION_PASSPHRASE="..." node scripts/create-migration-package.mjs
//   echo "passphrase" | node scripts/create-migration-package.mjs
//
// Environment:
//   BASE44_APP_ID           the source app id (e.g. 6a4957e7b03e9b10c170d29e)
//   BASE44_MIGRATE_SECRET   shared secret for the migrateSource function
//   BASE44_BASE_URL         optional override of https://<appId>.base44.app
//   MIGRATION_PASSPHRASE    passphrase for automation (non-interactive), min 16 chars

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { base44ConfigFromEnv } from '../server/src/lib/base44Source.js';
import { MigrationExporter } from '../server/src/lib/migrationExport/exporter.js';
import { generateTimestampedFilename, readHiddenPassphraseWithConfirmation, readPassphraseFromStdin } from './migrationCliUtils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'docs', 'resources');

const MIN_PASSPHRASE_LENGTH = 16;

function ensureDir(dir) {
  try {
    require('node:fs').mkdirSync(dir, { recursive: true });
  } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    output: '',
    diagnostic: '',
    preflightOnly: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) result.output = args[++i];
    else if (args[i] === '--diagnostic-report' && i + 1 < args.length) result.diagnostic = args[++i];
    else if (args[i] === '--preflight-only') result.preflightOnly = true;
    else if (args[i] === '--help' || args[i] === '-h') result.help = true;
    else if (args[i] === '--passphrase') {
      console.error('Error: --passphrase is no longer supported. Use interactive prompt, MIGRATION_PASSPHRASE env var, or stdin.');
      process.exit(1);
    }
  }

  if (result.help) {
    console.log(`
Usage: node scripts/create-migration-package.mjs [options]

Options:
  --output <path>             Output path for encrypted migration package
                              (default: docs/resources/legenex-dashflo-migration-YYYY-MM-DD-HH-mm.json.enc)
  --diagnostic-report <path>  Optional path for diagnostic report JSON
                              (default: docs/resources/legenex-dashflo-migration-diagnostic-YYYY-MM-DD-HH-mm.json)
  --preflight-only            Run validation only, do not create package
  --help, -h                  Show this help

Passphrase (choose one, interactive preferred for manual use):
  1. Interactive hidden prompt (default when stdin is a TTY)
  2. MIGRATION_PASSPHRASE environment variable (automation)
  3. Piped via stdin (automation)

Environment:
  BASE44_APP_ID           the source app id (e.g. 6a4957e7b03e9b10c170d29e)
  BASE44_MIGRATE_SECRET   shared secret for the migrateSource function
  BASE44_BASE_URL         optional override of https://<appId>.base44.app
  MIGRATION_PASSPHRASE    passphrase for automation (non-interactive), min 16 chars
`);
    process.exit(0);
  }

  return result;
}

async function main() {
  const args = parseArgs();

  let passphrase = '';
  let diagnosticPath = args.diagnostic;
  let outputPath = args.output;

  try {
    // Resolve default output paths ONCE at the start
    if (!outputPath) {
      ensureDir(DEFAULT_OUTPUT_DIR);
      outputPath = path.join(DEFAULT_OUTPUT_DIR, generateTimestampedFilename('legenex-dashflo-migration', 'json.enc'));
    }
    if (!diagnosticPath) {
      ensureDir(DEFAULT_OUTPUT_DIR);
      diagnosticPath = path.join(DEFAULT_OUTPUT_DIR, generateTimestampedFilename('legenex-dashflo-migration-diagnostic', 'json'));
    }

    // Resolve passphrase securely
    const stdinIsTTY = process.stdin.isTTY;
    if (stdinIsTTY) {
      // Interactive hidden prompt
      passphrase = await readHiddenPassphraseWithConfirmation(
        'Migration passphrase: ',
        'Confirm migration passphrase: ',
        MIN_PASSPHRASE_LENGTH
      );
    } else {
      // Non-interactive: stdin or env var
      const fromStdin = await readPassphraseFromStdin();
      if (fromStdin) {
        passphrase = fromStdin;
      } else {
        passphrase = process.env.MIGRATION_PASSPHRASE || '';
      }
      if (!passphrase) {
        console.error('Error: No passphrase provided. Use MIGRATION_PASSPHRASE env var or pipe via stdin for non-interactive use.');
        process.exit(1);
      }
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        console.error(`Error: passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
        process.exit(1);
      }
    }

    // Validate Base44 config early
    const config = base44ConfigFromEnv();
    if (!config.appId) {
      console.error('Error: BASE44_APP_ID must be set');
      process.exit(1);
    }
    if (!config.secret) {
      console.error('Error: BASE44_MIGRATE_SECRET must be set');
      process.exit(1);
    }

    const exporter = new MigrationExporter({
      config,
      passphrase,
      outputPath,
      diagnosticPath,
      preflightOnly: args.preflightOnly,
    });

    // Clear passphrase reference after passing to exporter
    passphrase = null;

    const startTime = Date.now();
    await exporter.run();
    const elapsedMs = Date.now() - startTime;

    // Read diagnostic report for summary
    const fs = await import('node:fs');
    const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));

    console.log('');
    console.log('Preflight: PASS');
    console.log(`Entities: ${Object.keys(diagnostic.entity_counts).length}`);
    console.log(`Records: ${diagnostic.total_record_count}`);
    console.log(`Recovered required parents: ${diagnostic.recovered_parent_records?.length || 0}`);
    console.log(`Identical duplicate occurrences removed: ${diagnostic.duplicate_source_id_findings?.reduce((sum, d) => sum + (d.identical || 0), 0) || 0}`);
    console.log(`Optional dangling references: ${diagnostic.optional_dangling_references?.length || 0}`);
    console.log(`Encrypted chunks: ${diagnostic.hard_blocker_count === 0 ? 'created' : 'N/A'}`);
    console.log(`Package: ${outputPath}`);
    console.log(`Diagnostic: ${diagnosticPath}`);
    console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  } catch (error) {
    if (passphrase) passphrase = null;

    if (error.message === 'PREFLIGHT_FAILED') {
      // Use the ALREADY resolved diagnostic path, not a new one
      const fs = await import('node:fs');
      let diagnostic = null;
      try {
        diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
      } catch {}

      console.error('');
      console.error('Preflight: FAIL');
      if (diagnostic) {
        console.error(`Hard blockers: ${diagnostic.hard_blocker_count}`);
        const byKind = {};
        for (const b of diagnostic.hard_blockers || []) {
          byKind[b.kind] = (byKind[b.kind] || 0) + 1;
        }
        for (const [kind, count] of Object.entries(byKind)) {
          console.error(`  ${kind}: ${count}`);
        }
      }
      console.error(`Diagnostic: ${diagnosticPath}`);
      process.exit(1);
    }

    if (error.message === 'Cancelled') {
      console.error('Cancelled');
      process.exit(130);
    }

    console.error('Export failed:', error.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});