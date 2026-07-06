import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTITIES_DIR = path.join(__dirname, 'entities');

// Strip // line comments and /* */ block comments from JSONC without touching
// occurrences inside string literals (e.g. "http://...").
function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const n = input[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += input[i + 1] ?? ''; i++; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function loadEntitySchemas() {
  const files = fs.readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.json'));
  const schemas = {};
  for (const file of files) {
    const raw = fs.readFileSync(path.join(ENTITIES_DIR, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      throw new Error(`Failed to parse entity schema ${file}: ${err.message}`);
    }
    const name = parsed.name || path.basename(file, '.json');
    schemas[name] = parsed;
  }
  return schemas;
}

export const entitySchemas = loadEntitySchemas();
export const entityNames = Object.keys(entitySchemas);

export function getSchema(name) {
  return entitySchemas[name] || null;
}

// snake_case table name for an entity, prefixed to avoid reserved words.
export function tableName(name) {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
  return `e_${snake}`;
}

export default entitySchemas;
