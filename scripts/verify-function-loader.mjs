// Backend function loader verification.
//
// Every file in server/src/functions that the loader treats as a handler must
// default-export a function. Helper and data modules are named with a leading
// underscore (the loader's existing convention, inherited from the original
// _shared layout) or end in .generated.js.
//
// This runs in the root gate so a helper dropped into the functions directory
// without the underscore prefix fails the build instead of failing at runtime
// on a production boot.

import { loadFunctions, loadErrors } from '../server/src/functions/index.js';

const registry = await loadFunctions();
const loaded = Object.keys(registry).length;
const errors = Object.entries(loadErrors);

console.log(`[loader] ${loaded} functions loaded`);

if (errors.length > 0) {
  console.error(`[loader] ${errors.length} module(s) failed to load as handlers:`);
  for (const [name, message] of errors) {
    console.error(`  - ${name}: ${message}`);
  }
  console.error(
    '[loader] Fix: give the module a default-exported handler, or rename it with a ' +
      'leading underscore if it is a helper or data module.',
  );
  process.exit(1);
}

if (loaded === 0) {
  console.error('[loader] No functions loaded at all. The loader or the tree is broken.');
  process.exit(1);
}

console.log('[loader] OK: every handler module default-exports a function.');
