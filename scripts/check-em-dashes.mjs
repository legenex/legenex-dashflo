// Em dash check, scoped to changed lines.
//
// The operating contract prohibits em dashes in human-facing copy, comments and
// documents. It does not prohibit valid programming syntax, and the repository
// already contains pre-existing em dashes inherited from the upstream sync, so
// a whole-repository ban would fail on day one and get switched off.
//
// This checks only lines this branch adds, which is where new human-facing text
// is written.

import { execFileSync } from 'node:child_process';

// Built from its code point so this file does not match its own check.
const EM_DASH = String.fromCharCode(0x2014);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function baseRef() {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git(['merge-base', 'HEAD', ref]).trim();
    } catch { /* ref may not exist in this checkout */ }
  }
  // No base to compare against: fall back to the working tree only.
  return null;
}

const base = baseRef();
// Committed changes on this branch plus anything still in the working tree.
// Untracked files are added to the index intent-to-add first, otherwise a brand
// new file is invisible to git diff and would skip the check entirely.
try {
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  if (untracked.length > 0) git(['add', '--intent-to-add', '--', ...untracked]);
} catch { /* nothing to stage */ }

const diff = base ? git(['diff', base, '--']) : git(['diff', 'HEAD', '--']);

const findings = [];
let currentFile = null;
let newLineNo = 0;

for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6);
    continue;
  }
  if (line.startsWith('@@')) {
    const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    newLineNo = m ? parseInt(m[1], 10) : 0;
    continue;
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    if (line.includes(EM_DASH)) {
      findings.push({ file: currentFile, line: newLineNo, text: line.slice(1).trim() });
    }
    newLineNo += 1;
  } else if (!line.startsWith('-')) {
    newLineNo += 1;
  }
}

if (findings.length > 0) {
  console.error(`[em-dash] ${findings.length} added line(s) contain an em dash:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text.slice(0, 110)}`);
  }
  console.error('[em-dash] Use a comma, a colon, or a full stop instead.');
  process.exit(1);
}

console.log(`[em-dash] OK: no em dashes in lines added${base ? ` since ${base.slice(0, 8)}` : ''}.`);
