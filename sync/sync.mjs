#!/usr/bin/env node
// DashOS upstream sync pipeline.
//
// Pulls the source repo, detects what changed, and replicates the changes into
// this standalone app: copies + de-couples frontend files, syncs entity schemas,
// regenerates function shims, ports changed backend functions, rebuilds the
// client, and restarts the API server. Designed to run hourly under launchd.
//
// Usage:
//   node sync/sync.mjs --init          record current upstream HEAD as baseline (no transform)
//   node sync/sync.mjs                  fetch + apply any new changes
//   node sync/sync.mjs --force          run even if there are no new commits
//   node sync/sync.mjs --all            re-transform everything from upstream (uses backups)
//   node sync/sync.mjs --no-build       skip the client build
//   node sync/sync.mjs --no-restart     skip restarting the server

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UPSTREAM = path.join(ROOT, '.sync', 'upstream');
const CLIENT = path.join(ROOT, 'client');
const CLIENT_SRC = path.join(CLIENT, 'src');
const SERVER_FUNCS = path.join(ROOT, 'server', 'src', 'functions');
const SCHEMAS = path.join(ROOT, 'server', 'src', 'schemas', 'entities');
const STATE_DIR = path.join(HERE, 'state');
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const LOG_FILE = path.join(STATE_DIR, 'sync.log');
const STATE_FILE = path.join(STATE_DIR, 'last-sync.json');
const REPO_URL = 'https://github.com/legenex/legenex-dashboard';
const BRANCH = 'main';

// Client files we hand-rewrote for the standalone app — never overwrite these
// from upstream. If upstream changes the corresponding source, we flag it.
const CLIENT_OVERRIDES = new Set([
  'src/api/base44Client.js', // upstream has this; we delete it (replaced by client.js)
  'src/lib/app-params.js',
  'src/lib/AuthContext.jsx',
]);
const DELETE_ON_SIGHT = new Set(['src/api/base44Client.js']);
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

const args = new Set(process.argv.slice(2));
const flag = (f) => args.has(f);

const warnings = [];
const actions = [];
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendLog(line); };
function appendLog(line) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {} }

function ensureDirs() {
  for (const d of [STATE_DIR, BACKUP_DIR, PENDING_DIR]) fs.mkdirSync(d, { recursive: true });
}

function git(cwd, cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd, encoding: 'utf8' }).trim();
}

function ensureUpstream() {
  if (!fs.existsSync(path.join(UPSTREAM, '.git'))) {
    log(`cloning upstream ${REPO_URL} -> .sync/upstream`);
    fs.mkdirSync(path.dirname(UPSTREAM), { recursive: true });
    execFileSync('git', ['clone', '--quiet', REPO_URL, UPSTREAM], { stdio: 'inherit' });
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── rename transform (identical to the manual de-coupling) ──────────────────
// Scrubs every trace of the source platform: hosted asset URLs, the SDK import
// path, the `base44` identifier, and brand mentions in comments/strings.
// Asset-URL rewrites run FIRST (before the identifier rename would mangle the
// domain). Platform-hosted images map to /brand/<filename>, served from
// client/public/brand — download the asset there (the sync logs any it finds).
function transformCode(text) {
  return text
    .replace(/https?:\/\/media\.base44\.com\/images\/public\/[^/"'`)\s]+\/([^"'`)\s]+)/g, '/brand/$1')
    .replace(/https?:\/\/base44\.com\/logo_v2\.svg/g, '/favicon.svg')
    .replace(/@\/api\/base44Client/g, '@/api/client')
    .replace(/\bbase44\b/g, 'api')          // identifier usage
    .replace(/\bBase44\b/g, 'the backend')  // Title-case brand mentions (prose)
    .replace(/Base44/g, 'Entity')           // embedded in camelCase ids (makeBase44CapStore)
    .replace(/\bBASE44\b/g, 'BACKEND');
}

// Download any platform-hosted images referenced in `raw` into
// client/public/brand so the app has no external asset dependency. Best-effort:
// logs a warning if a download fails so it can be handled manually.
const BRAND_DIR = path.join(CLIENT, 'public', 'brand');
function ensureBrandAssets(raw) {
  const re = /https?:\/\/media\.base44\.com\/images\/public\/[^/"'`)\s]+\/([^"'`)\s]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const url = m[0];
    const file = m[1];
    const dest = path.join(BRAND_DIR, file);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(BRAND_DIR, { recursive: true });
    try {
      execFileSync('curl', ['-sSL', '-o', dest, url], { timeout: 30000 });
      actions.push(`brand asset: ${file}`);
    } catch (e) {
      warnings.push(`could not download brand asset ${file} — add it to client/public/brand/ manually (${e.message.split('\n')[0]})`);
    }
  }
}

function backup(destAbs) {
  if (!fs.existsSync(destAbs)) return;
  const rel = path.relative(ROOT, destAbs).replace(/[\/\\]/g, '__');
  const stamp = readState()._stamp || 'run';
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(destAbs, path.join(dir, rel));
}

// ── client sync ──────────────────────────────────────────────────────────────
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

function syncClientFile(relFromSrc) {
  // relFromSrc is relative to upstream/src, e.g. "pages/Leads.jsx"
  const upRel = path.join('src', relFromSrc);
  if (upRel.startsWith(path.join('src', 'doc'))) return; // docs not shipped
  if (CLIENT_OVERRIDES.has(upRel)) {
    warnings.push(`upstream changed ${upRel} which is a standalone override — review manually (kept local version)`);
    return;
  }
  const from = path.join(UPSTREAM, upRel);
  const to = path.join(CLIENT_SRC, relFromSrc);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const ext = path.extname(from);
  if (CODE_EXT.has(ext)) {
    const raw = fs.readFileSync(from, 'utf8');
    ensureBrandAssets(raw); // localize any platform-hosted images this file references
    fs.writeFileSync(to, transformCode(raw));
  } else {
    fs.copyFileSync(from, to);
  }
  actions.push(`client: ${relFromSrc}`);
}

function deleteClientFile(relFromSrc) {
  const upRel = path.join('src', relFromSrc);
  if (CLIENT_OVERRIDES.has(upRel)) return;
  const to = path.join(CLIENT_SRC, relFromSrc);
  if (fs.existsSync(to)) { fs.rmSync(to); actions.push(`client (deleted): ${relFromSrc}`); }
}

function purgeDeletedClient() {
  const base44ClientFile = path.join(CLIENT_SRC, 'api', 'base44Client.js');
  if (fs.existsSync(base44ClientFile)) fs.rmSync(base44ClientFile);
}

function syncIndexHtml() {
  const from = path.join(UPSTREAM, 'index.html');
  if (!fs.existsSync(from)) return;
  let html = fs.readFileSync(from, 'utf8');
  html = html
    .replace(/<link rel="icon"[^>]*href="https:\/\/base44\.com[^"]*"[^>]*\/>/g, '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    .replace(/<title>[^<]*<\/title>/g, '<title>Legenex DashOS</title>');
  fs.writeFileSync(path.join(CLIENT, 'index.html'), html);
  actions.push('client: index.html');
}

// ── schemas ──────────────────────────────────────────────────────────────────
function syncSchema(name) {
  const from = path.join(UPSTREAM, 'base44', 'entities', `${name}.jsonc`);
  const to = path.join(SCHEMAS, `${name}.json`);
  if (!fs.existsSync(from)) { if (fs.existsSync(to)) { fs.rmSync(to); actions.push(`schema (deleted): ${name}`); } return; }
  fs.copyFileSync(from, to);
  actions.push(`schema: ${name}`);
}

// ── function shims (frontend) ────────────────────────────────────────────────
function regenShims() {
  const fnDir = path.join(UPSTREAM, 'base44', 'functions');
  if (!fs.existsSync(fnDir)) return;
  const names = fs.readdirSync(fnDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const valid = new Set(names);
  const shimDir = path.join(CLIENT_SRC, 'functions');
  fs.mkdirSync(shimDir, { recursive: true });
  for (const name of names) {
    const file = path.join(shimDir, `${name}.js`);
    const content = `// Callable wrapper for the '${name}' backend function.\nimport { functions } from '@/api/client';\nexport const ${name} = (body = {}) => functions.invoke('${name}', body);\nexport default ${name};\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      fs.writeFileSync(file, content);
      actions.push(`shim: ${name}`);
    }
  }
  // Remove shims + server ports for functions that no longer exist upstream.
  for (const f of fs.readdirSync(shimDir)) {
    const nm = f.replace(/\.js$/, '');
    if (f.endsWith('.js') && !valid.has(nm)) {
      fs.rmSync(path.join(shimDir, f));
      const serverPort = path.join(SERVER_FUNCS, f);
      if (fs.existsSync(serverPort)) { backup(serverPort); fs.rmSync(serverPort); }
      actions.push(`function (removed): ${nm}`);
    }
  }
}

// ── backend function porting ─────────────────────────────────────────────────
// True if `code` parses as valid JS (node --check on a temp file).
function checkSyntax(code) {
  const tmp = path.join(os.tmpdir(), `dashos-port-${process.pid}-${Math.abs(hashStr(code))}.mjs`);
  try {
    fs.writeFileSync(tmp, code);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore' });
    return true;
  } catch { return false; }
  finally { try { fs.rmSync(tmp); } catch {} }
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

// Copy shared sibling modules that ported functions import (e.g. each function
// dir bundles a copy of routingEngine.generated.js, loaded via
// `import './routingEngine.generated.js'`). One transformed copy in
// server/src/functions/ serves them all. Ignores entry.ts (that's the function).
function syncSharedFunctionFiles() {
  const fnDir = path.join(UPSTREAM, 'base44', 'functions');
  if (!fs.existsSync(fnDir)) return;
  const written = new Set();
  for (const d of fs.readdirSync(fnDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const inner = path.join(fnDir, d.name);
    for (const file of fs.readdirSync(inner)) {
      if (file === 'entry.ts' || !file.endsWith('.js') || written.has(file)) continue;
      written.add(file);
      const dest = path.join(SERVER_FUNCS, file);
      const next = transformCode(fs.readFileSync(path.join(inner, file), 'utf8'));
      if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== next) {
        fs.writeFileSync(dest, next);
        actions.push(`shared function file: ${file}`);
      }
    }
  }
}

function claudeAvailable() {
  try { execFileSync('claude', ['--version'], { encoding: 'utf8', env: { ...process.env, CLAUDE_NOTIFIER_DISABLE: '1' } }); return true; } catch { return false; }
}

function mechanicalPort(src, name) {
  let s = src;
  // Strip the platform SDK import line(s).
  s = s.replace(/^\s*import\s+\{[^}]*\}\s+from\s+['"]npm:@base44\/sdk[^'"]*['"];?\s*$/gm, '');
  s = s.replace(/^\s*import\s+[^\n]*@base44\/sdk[^\n]*$/gm, '');
  // Deno.serve wrapper -> default export handler.
  s = s.replace(/Deno\.serve\(\s*async\s*\(\s*([A-Za-z_$][\w$]*)?\s*\)\s*=>\s*\{/, `export default async function ${name}(ctx) {`);
  s = s.replace(/Deno\.serve\(\s*async\s*([A-Za-z_$][\w$]*)?\s*=>\s*\{/, `export default async function ${name}(ctx) {`);
  // Remove the trailing "});" that closed Deno.serve.
  s = s.replace(/\}\s*\)\s*;?\s*$/, '}\n');
  // Runtime translations.
  s = s.replace(/const\s+base44\s*=\s*createClientFromRequest\([^)]*\)\s*;?/g, 'const db = ctx.db;');
  s = s.replace(/createClientFromRequest\([^)]*\)/g, 'ctx.db');
  s = s.replace(/await\s+req\.json\(\)(\.catch\([^)]*\))?/g, 'ctx.body');
  s = s.replace(/req\.json\(\)/g, 'ctx.body');
  s = s.replace(/req\.method/g, 'ctx.req.method');
  s = s.replace(/Deno\.env\.get\(\s*['"]([^'"]+)['"]\s*\)/g, 'ctx.env.$1');
  s = s.replace(/\bbase44\b/g, 'db');
  // Response.json(x, { status: N }) -> ctx.json(x, N); Response.json(x) -> ctx.json(x)
  s = s.replace(/Response\.json\(/g, 'ctx.json(');
  s = s.replace(/,\s*\{\s*status:\s*([0-9]+)\s*\}\s*\)/g, ', $1)');
  const header = `// AUTO-PORTED (mechanical fallback) on ${new Date().toISOString()} — REVIEW RECOMMENDED.\n// Verify: auth (requireUser), credentials via ctx.config.integrations.*, and LLM via ../integrations/llm.js.\n`;
  return header + s;
}

function claudePort(entrySrc, name) {
  const guide = fs.readFileSync(path.join(HERE, 'PORTING.md'), 'utf8');
  const prompt = [
    'Port ONE serverless function from Deno to a Node ESM module for a standalone app.',
    'Follow this porting guide EXACTLY:',
    '', '=== PORTING GUIDE ===', guide, '=== END GUIDE ===', '',
    `The output module is server/src/functions/${name}.js and must default-export "async function ${name}(ctx)".`,
    'ctx = { body, user, db, env, config, req, json }. Use requireUser/HttpError/json from "./_runtime.js",',
    'callLLM/invokeLLM from "../integrations/llm.js", sendMail from "../lib/mailer.js" as needed.',
    'Read credentials from ctx.config.integrations.* falling back to ctx.env.*; degrade gracefully when missing.',
    'Preserve exact response body field names and status codes.',
    'CRITICAL: Output ONLY the raw JavaScript file contents. Start immediately with the first import/const line.',
    'No prose, no explanation, no markdown code fences.',
    '', '=== ORIGINAL Deno source (entry.ts) ===', entrySrc,
  ].join('\n');
  // Run with all file/exec tools denied and from a neutral cwd so claude emits
  // the code as plain text instead of trying to write files / ask permission.
  const out = execFileSync(
    'claude',
    ['-p', prompt, '--output-format', 'text', '--disallowedTools', 'Write', 'Edit', 'Read', 'Bash', 'Glob', 'Grep'],
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      // Large functions (e.g. the ~1800-line processLead) can take several
      // minutes to port; keep this generous so they don't time out and fall
      // back to a staged mechanical port. The hourly cadence has room for it.
      timeout: 900000,
      maxBuffer: 32 * 1024 * 1024,
      // Silence the desktop notifier hooks for these automated invocations.
      env: { ...process.env, CLAUDE_NOTIFIER_DISABLE: '1' },
    }
  );
  return sanitizeGeneratedCode(out);
}

// Extract a clean JS module from an LLM response that may include a prose
// preamble ("Here is the file:"), markdown fences, or trailing commentary.
function sanitizeGeneratedCode(out) {
  let text = String(out);
  // Prefer the content of a fenced code block if present.
  const fence = text.match(/```(?:javascript|js|ts|typescript)?\s*\n([\s\S]*?)\n```/i);
  if (fence) text = fence[1];
  else text = text.replace(/```(?:javascript|js|ts|typescript)?/gi, '');
  // Drop any leading lines until the first real code line (import/const/comment/etc.),
  // discarding prose like "I don't have filesystem access..." or "Here is the file:".
  const lines = text.split('\n');
  const startRe = /^\s*(import\b|export\b|const\b|let\b|var\b|function\b|async\b|\/\/|\/\*|['"]use )/;
  let start = lines.findIndex((l) => startRe.test(l));
  if (start > 0) lines.splice(0, start);
  // Drop any trailing prose the model appended after the module (e.g. "I wrote
  // the port above…", "Notes on the translation:") by cutting at the last
  // top-level closing brace — the real end of a single-export module.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (/^\}\s*$/.test(lines[i])) { end = i; break; } }
  if (end >= 0 && end < lines.length - 1) lines.splice(end + 1);
  return lines.join('\n').trim() + '\n';
}

function portBackendFunction(name, { hasClaude, isNew }) {
  const entry = path.join(UPSTREAM, 'base44', 'functions', name, 'entry.ts');
  const dest = path.join(SERVER_FUNCS, `${name}.js`);
  if (!fs.existsSync(entry)) {
    if (fs.existsSync(dest)) { backup(dest); fs.rmSync(dest); actions.push(`function (deleted): ${name}`); }
    return;
  }
  const src = fs.readFileSync(entry, 'utf8');

  let ported = null;
  let mode = 'mechanical';
  if (hasClaude) {
    try { ported = claudePort(src, name); mode = 'claude'; }
    catch (e) { warnings.push(`claude port failed for ${name}: ${e.message.split('\n')[0]} — used mechanical fallback`); }
  }
  if (!ported) ported = mechanicalPort(src, name);

  // Sanity gate: reject ports that still contain platform tokens, don't look like
  // a module (leaked prose), lack the expected default export, leave TypeScript
  // syntax, or fail to parse. Anything suspect is staged, never applied.
  const hasForbidden = /Deno\.|createClientFromRequest|from ['"]npm:|\bbase44\b/i.test(ported);
  const looksLikeCode = /^\s*(import\b|export\b|const\b|\/\/|\/\*)/.test(ported);
  const hasExport = /export\s+default/.test(ported);
  // `node --check` (syntaxOk) is the authoritative check — real TypeScript
  // annotations fail to parse and are caught here. We only additionally flag
  // an `interface` declaration, which can be valid-adjacent; we do NOT flag
  // `: type` / `<Generic>` patterns since those false-positive on comments and
  // Graph-API strings, over-staging perfectly valid ports.
  const hasInterface = /^\s*interface\s+[A-Z]/m.test(ported);
  const syntaxOk = checkSyntax(ported);
  const dirty = hasForbidden || !looksLikeCode || !hasExport || hasInterface || !syntaxOk;

  if (isNew) {
    if (dirty) {
      // Never apply a suspect port, even for a brand-new function.
      const p = path.join(PENDING_DIR, `${name}.js`);
      fs.writeFileSync(p, ported);
      warnings.push(`new function ${name}: port looks incomplete (${mode}) — staged at sync/state/pending/${name}.js (NOT applied)`);
    } else {
      fs.writeFileSync(dest, ported);
      actions.push(`function (new, ${mode}): ${name}`);
    }
  } else {
    // Existing (hand-ported) function changed upstream.
    if (mode === 'claude' && !dirty) {
      backup(dest);
      fs.writeFileSync(dest, ported);
      actions.push(`function (updated, claude): ${name}`);
    } else {
      const p = path.join(PENDING_DIR, `${name}.js`);
      fs.writeFileSync(p, ported);
      warnings.push(`function ${name} changed upstream — staged port at sync/state/pending/${name}.js; live version kept (review & apply)`);
    }
  }
}

// Detect `api.<namespace>` usages in the client that our SDK does not provide —
// i.e. a new platform SDK surface the upstream started using that must be
// implemented in client/src/api/client.js (this is how api.users.inviteUser
// first appeared). Ignores our own SDK namespaces and known non-SDK `api` vars
// (embla carousel instances, hostnames like api.legenex.com).
const SDK_NAMESPACES = new Set(['entities', 'asServiceRole', 'auth', 'users', 'functions', 'integrations', 'request', 'getToken', 'setToken']);
const IGNORE_API_PROPS = new Set([
  // embla carousel instance methods
  'on', 'off', 'canScrollNext', 'canScrollPrev', 'scrollTo', 'scrollNext', 'scrollPrev',
  'scrollSnapList', 'selectedScrollSnap', 'reInit', 'plugins', 'internalEngine',
  // hostname fragments that survive as api.<tld>
  'legenex', 'com', 'io', 'net', 'org', 'app', 'tiktok',
]);
function checkNewSdkSurfaces() {
  const seen = new Set();
  const files = walk(CLIENT_SRC);
  for (const rel of files) {
    if (!CODE_EXT.has(path.extname(rel))) continue;
    const text = fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8');
    const re = /\bapi\.([a-zA-Z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const ns = m[1];
      if (SDK_NAMESPACES.has(ns) || IGNORE_API_PROPS.has(ns) || seen.has(ns)) continue;
      seen.add(ns);
      warnings.push(`possible new SDK surface "api.${ns}" in ${rel} — implement it in client/src/api/client.js (unknown namespaces will break at runtime)`);
    }
  }
}

// Install frontend dependencies the upstream added that the client lacks
// (platform SDK packages are intentionally skipped). Prevents build failures
// from unresolved imports of newly-introduced libraries.
function installNewDeps() {
  let up, mine;
  try {
    up = JSON.parse(fs.readFileSync(path.join(UPSTREAM, 'package.json'), 'utf8'));
    mine = JSON.parse(fs.readFileSync(path.join(CLIENT, 'package.json'), 'utf8'));
  } catch { return; }
  const have = { ...(mine.dependencies || {}), ...(mine.devDependencies || {}) };
  const missing = Object.entries(up.dependencies || {})
    .filter(([name]) => !have[name] && !name.startsWith('@base44'))
    .map(([name, ver]) => `${name}@${ver}`);
  if (!missing.length) return;
  log(`installing ${missing.length} new client dep(s): ${missing.join(', ')}`);
  try {
    execFileSync('npm', ['install', ...missing], { cwd: CLIENT, encoding: 'utf8', timeout: 300000 });
    missing.forEach((m) => actions.push(`dep: ${m}`));
  } catch (e) {
    warnings.push(`failed to install new deps (${missing.join(', ')}) — install manually: ${e.message.split('\n')[0]}`);
  }
}

// ── build + restart ──────────────────────────────────────────────────────────
function buildClient() {
  log('building client…');
  execSync('npm run build', { cwd: CLIENT, stdio: 'inherit' });
}

function restartServer() {
  const uid = process.getuid();
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/com.legenex.dashos.server`], { encoding: 'utf8' });
    log('server restarted via launchd');
  } catch {
    // Fallback: kill + detached start.
    try { execSync("pkill -f 'node src/index.js'"); } catch {}
    execSync('nohup node src/index.js > sync/state/server.log 2>&1 &', { cwd: path.join(ROOT, 'server'), shell: '/bin/bash' });
    log('server restarted via fallback (pkill + nohup)');
  }
}

// Commit the replicated changes and push to the project repo (origin/main).
// Disabled with --no-push or DASHOS_SYNC_NO_PUSH=1. Never throws — a git/push
// failure is logged as a warning so the sync itself still succeeds.
function commitAndPush(oldRev, remoteRev) {
  if (flag('--no-push') || /^(1|true|yes)$/i.test(process.env.DASHOS_SYNC_NO_PUSH || '')) {
    log('auto-push disabled — skipping git commit/push');
    return;
  }
  const name = process.env.DASHOS_GIT_NAME || 'legenex';
  const email = process.env.DASHOS_GIT_EMAIL || 'team@legenex.com';
  const branch = process.env.DASHOS_GIT_BRANCH || 'main';
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  try {
    // Ensure this is a git repo with a remote before attempting anything.
    try { git(['rev-parse', '--is-inside-work-tree']); } catch { log('not a git repo — skipping auto-push'); return; }
    git(['add', '-A']);
    // Nothing staged? (all changes were gitignored) -> nothing to commit.
    try { git(['diff', '--cached', '--quiet']); log('nothing to commit'); return; } catch { /* staged changes exist */ }

    const range = oldRev ? `${oldRev.slice(0, 8)}..${remoteRev.slice(0, 8)}` : remoteRev.slice(0, 8);
    const summary = actions.slice(0, 20).map((a) => `- ${a}`).join('\n');
    const msg = `Auto-sync upstream ${range} (${actions.length} change${actions.length === 1 ? '' : 's'})\n\n${summary}`;
    git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', msg]);
    log(`committed ${actions.length} change(s)`);

    try {
      git(['push', 'origin', branch]);
      log(`pushed to origin/${branch}`);
    } catch (e) {
      warnings.push(`git push failed — commit is local only, will push next run: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-1)[0]}`);
    }
  } catch (e) {
    warnings.push(`auto commit/push failed: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-1)[0]}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function classifyChanges(oldRev, newRev, full) {
  // Returns { clientFiles:Set, clientDeletes:Set, schemas:Set, schemaDeletes:Set, funcs:Set, funcDeletes:Set, depsChanged, indexChanged }
  const res = { clientFiles: new Set(), clientDeletes: new Set(), schemas: new Set(), funcs: new Set(), depsChanged: false, indexChanged: false };
  let files;
  if (full || !oldRev) {
    files = git(UPSTREAM, ['ls-files']).split('\n').map((f) => ({ status: 'A', path: f }));
  } else {
    files = git(UPSTREAM, ['diff', '--name-status', oldRev, newRev]).split('\n').filter(Boolean).map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest[rest.length - 1] };
    });
  }
  for (const { status, path: p } of files) {
    if (!p) continue;
    if (p === 'index.html') res.indexChanged = true;
    else if (p === 'package.json') res.depsChanged = true;
    else if (p.startsWith('src/')) {
      const rel = p.slice(4);
      if (status === 'D') res.clientDeletes.add(rel); else res.clientFiles.add(rel);
    } else if (p.startsWith('base44/entities/')) {
      const m = p.match(/base44\/entities\/(.+)\.jsonc$/);
      if (m) res.schemas.add(m[1]);
    } else if (p.startsWith('base44/functions/')) {
      const m = p.match(/base44\/functions\/([^/]+)\//);
      if (m) res.funcs.add(m[1]);
    }
  }
  return res;
}

async function main() {
  ensureDirs();
  ensureUpstream();

  const state = readState();
  const oldRev = state.lastCommit || null;

  // Fetch + hard-sync to remote branch (upstream is a read-only mirror).
  git(UPSTREAM, ['fetch', '--quiet', 'origin', BRANCH]);
  const remoteRev = git(UPSTREAM, ['rev-parse', `origin/${BRANCH}`]);

  if (flag('--init')) {
    git(UPSTREAM, ['reset', '--hard', `origin/${BRANCH}`]);
    writeState({ lastCommit: remoteRev, initializedAt: new Date().toISOString() });
    log(`initialized baseline at ${remoteRev.slice(0, 8)} (no transform applied)`);
    return;
  }

  const full = flag('--all');
  if (!full && oldRev === remoteRev && !flag('--force')) {
    log(`no changes (at ${remoteRev.slice(0, 8)})`);
    return;
  }

  git(UPSTREAM, ['reset', '--hard', `origin/${BRANCH}`]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeState({ ...state, _stamp: stamp });

  log(`syncing ${oldRev ? oldRev.slice(0, 8) : '(init)'} -> ${remoteRev.slice(0, 8)}${full ? ' [full]' : ''}`);
  const changes = classifyChanges(oldRev, remoteRev, full);

  // Existing server function ports (to distinguish new vs changed).
  const existingFuncs = new Set(fs.readdirSync(SERVER_FUNCS).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js').map((f) => f.replace(/\.js$/, '')));
  const hasClaude = claudeAvailable();
  if (changes.funcs.size && !hasClaude) warnings.push('claude CLI not found — backend function changes will use mechanical port / staging');

  // Apply.
  for (const rel of changes.clientFiles) syncClientFile(rel);
  for (const rel of changes.clientDeletes) deleteClientFile(rel);
  purgeDeletedClient();
  if (changes.indexChanged || full) syncIndexHtml();
  for (const name of changes.schemas) syncSchema(name);
  regenShims();
  for (const name of changes.funcs) portBackendFunction(name, { hasClaude, isNew: !existingFuncs.has(name) });
  syncSharedFunctionFiles();

  if (changes.depsChanged) installNewDeps();

  checkNewSdkSurfaces();

  const nothingApplied = actions.length === 0;
  log(`applied ${actions.length} change(s)` + (warnings.length ? `, ${warnings.length} warning(s)` : ''));
  actions.slice(0, 50).forEach((a) => appendLog(`  + ${a}`));
  warnings.forEach((w) => { const line = `  ! ${w}`; console.log(line); appendLog(line); });

  // Build + restart only if something client-facing or functional changed.
  if (!flag('--no-build') && !nothingApplied) {
    try { buildClient(); }
    catch (e) { warnings.push(`client build FAILED: ${e.message.split('\n')[0]}`); log('client build FAILED — server NOT restarted; previous dist kept'); }
  }
  const buildFailed = warnings.some((w) => w.startsWith('client build FAILED'));
  if (!flag('--no-restart') && !nothingApplied && !buildFailed) restartServer();

  // Commit + push the replicated changes to the project repo (unless disabled or
  // the build failed — we never push a broken build).
  if (!nothingApplied && !buildFailed) commitAndPush(oldRev, remoteRev);

  writeState({ lastCommit: remoteRev, lastSyncAt: new Date().toISOString(), applied: actions.length, warnings });
  log(`done (${remoteRev.slice(0, 8)})`);
}

main().catch((e) => { log(`SYNC ERROR: ${e.stack || e.message}`); process.exit(1); });
