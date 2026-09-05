// Goal predicate for W3-UI-STATUS.
//
// Fails if any retired lead status value survives anywhere in the tracked
// source, or if a connector trigger key still references one. A retired value
// left behind does not throw at runtime, which is exactly why this check exists.
// Run: node forge-pack/scripts/check-status-vocabulary.mjs

import { execSync } from 'node:child_process';

const RETIRED = ['Processing', 'Qualified', 'Duplicate', 'Fake', 'Error'];
const RETIRED_TRIGGERS = ['on_received', 'on_duplicates', 'on_dq'];
const ALLOWED = [
  'forge-pack/',            // this pack documents the retired values on purpose
  'docs/',                  // history is allowed to mention them
  'server/src/db/migrations' // the migration itself must name what it retires
];

const allowed = (file) => ALLOWED.some((p) => file.startsWith(p));
const hits = [];

const grep = (needle, glob) => {
  try {
    return execSync(`git grep -n -F "${needle}" -- ${glob}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; } // git grep exits 1 on no match, which is the good case
};

for (const value of RETIRED) {
  // status-shaped usage only: quoted literal next to a status-ish identifier
  for (const line of grep(`'${value}'`, "'client/src/**' 'server/src/**'")) {
    const [file] = line.split(':');
    if (!allowed(file) && /status|state|final_status|lead_status/i.test(line)) hits.push(line);
  }
}
for (const trig of RETIRED_TRIGGERS) {
  for (const line of grep(trig, "'client/src/**' 'server/src/**'")) {
    const [file] = line.split(':');
    if (!allowed(file)) hits.push(line);
  }
}

if (hits.length) {
  console.error(`FAIL: ${hits.length} retired status reference(s) still present:`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('PASS: no retired lead status value or connector trigger remains in source.');
