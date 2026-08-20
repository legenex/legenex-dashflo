#!/usr/bin/env node
// Owner Migration Package Exporter
//
// Creates a referentially complete, deterministic DashFlo migration package from
// Base44 (legenex-dashboard) data. Performs preflight validation before encryption.
//
// Usage:
//   node scripts/create-migration-package.mjs --passphrase "..." --output migration-package.json
//   node scripts/create-migration-package.mjs --passphrase "..." --output migration-package.json --preflight-only
//   node scripts/create-migration-package.mjs --passphrase "..." --output migration-package.json --diagnostic-report diagnostic.json
//
// Environment:
//   BASE44_APP_ID           the source app id (e.g. 6a4957e7b03e9b10c170d29e)
//   BASE44_MIGRATE_SECRET   shared secret for the migrateSource function
//   BASE44_BASE_URL         optional override of https://<appId>.base44.app

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { base44ConfigFromEnv } from '../server/src/lib/base44Source.js';
import { MigrationExporter } from '../server/src/lib/migrationExport/exporter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { passphrase: '', output: '', diagnostic: '', preflightOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--passphrase' && i + 1 < args.length) result.passphrase = args[++i];
    else if (args[i] === '--output' && i + 1 < args.length) result.output = args[++i];
    else if (args[i] === '--diagnostic-report' && i + 1 < args.length) result.diagnostic = args[++i];
    else if (args[i] === '--preflight-only') result.preflightOnly = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/create-migration-package.mjs --passphrase "..." --output migration-package.json [options]

Options:
  --passphrase <string>       Migration passphrase (minimum 16 characters)
  --output <path>             Output path for encrypted migration package
  --diagnostic-report <path>  Optional path for diagnostic report JSON
  --preflight-only            Run validation only, do not create package
  --help, -h                  Show this help
`);
      process.exit(0);
    }
  }

  if (!result.passphrase) {
    console.error('Error: --passphrase is required');
    process.exit(1);
  }
  if (result.passphrase.length < 16) {
    console.error('Error: passphrase must be at least 16 characters');
    process.exit(1);
  }
  if (!result.output) {
    console.error('Error: --output is required');
    process.exit(1);
  }

  return result;
}

async function main() {
  const args = parseArgs();

  const config = base44ConfigFromEnv();
  if (!config.appId || !config.secret) {
    console.error('Error: BASE44_APP_ID and BASE44_MIGRATE_SECRET must be set');
    process.exit(1);
  }

  const exporter = new MigrationExporter({
    config,
    passphrase: args.passphrase,
    outputPath: args.output,
    diagnosticPath: args.diagnostic || null,
    preflightOnly: args.preflightOnly,
  });

  try {
    await exporter.run();
    console.log('Export completed successfully');
  } catch (error) {
    if (error.message === 'PREFLIGHT_FAILED') {
      console.error('Export preflight failed');
      process.exit(1);
    }
    console.error('Export failed:', error.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});