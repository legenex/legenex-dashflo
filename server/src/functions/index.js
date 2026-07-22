import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically load every function module (files not starting with "_").
const registry = {};
export const loadErrors = {};
export async function loadFunctions() {
  // Load function modules only. Skip helpers (_*), the loader itself, and shared
  // bundles like routingEngine.generated.js (imported by functions, not functions).
  const files = fs.readdirSync(__dirname).filter(
    (f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js' && !f.endsWith('.generated.js')
  );
  for (const file of files) {
    const name = path.basename(file, '.js');
    // Never let one bad function module crash the whole server — skip it and
    // record the error so /api/functions can report it.
    try {
      const mod = await import(pathToFileURL(path.join(__dirname, file)).href);
      if (typeof mod.default === 'function') registry[name] = mod.default;
      else loadErrors[name] = 'no default export';
    } catch (err) {
      loadErrors[name] = err.message;
      console.error(`[functions] failed to load ${file}: ${err.message}`);
    }
  }
  return registry;
}

export function getFunction(name) {
  return registry[name] || null;
}

export function functionNames() {
  return Object.keys(registry);
}

export default registry;
