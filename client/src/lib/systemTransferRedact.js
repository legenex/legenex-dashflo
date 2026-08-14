// Redaction for system export bundles.
//
// A bundle is a file that leaves the system and lands in a downloads folder, so
// it is treated as a log: no credential value may appear in it, ever, for any
// operator. This module is generated into the backend function folders and runs
// server side. The client never decides what is redacted.
//
// Three passes:
//   1. Named secret fields, replaced wholesale.
//   2. Blob fields (headers, config JSON), scrubbed key by key so the shape of
//      the config survives while the values do not.
//   3. URL fields, where credentials commonly ride in the query string. Host and
//      path are kept so the destination stays recognisable.

import {
  REDACTED, SECRET_FIELDS, SECRET_BLOB_FIELDS, SECRET_URL_FIELDS, SECRET_KEY_PATTERN, FIELD_STRIP,
} from './systemTransfer.js';

function scrubObject(value, hits, path) {
  if (Array.isArray(value)) return value.map((v, i) => scrubObject(v, hits, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = REDACTED;
        hits.push(`${path}.${k}`);
      } else {
        out[k] = scrubObject(v, hits, `${path}.${k}`);
      }
    }
    return out;
  }
  return value;
}

// Header blobs are sometimes stored as JSON, sometimes as raw "Key: value" lines.
function scrubBlob(raw, hits, path) {
  if (raw == null || raw === '') return raw;
  if (typeof raw !== 'string') return scrubObject(raw, hits, path);

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubObject(JSON.parse(trimmed), hits, path));
    } catch {
      // Fall through to line scrubbing when the blob is not valid JSON.
    }
  }

  return raw
    .split('\n')
    .map((line) => {
      const sep = line.indexOf(':');
      if (sep === -1) return line;
      const name = line.slice(0, sep);
      if (!SECRET_KEY_PATTERN.test(name)) return line;
      hits.push(`${path}.${name.trim()}`);
      return `${name}: ${REDACTED}`;
    })
    .join('\n');
}

function scrubUrl(raw, hits, path) {
  if (!raw || typeof raw !== 'string') return raw;
  const qIndex = raw.indexOf('?');
  if (qIndex === -1) return raw;

  const base = raw.slice(0, qIndex);
  const query = raw.slice(qIndex + 1);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const name = pair.slice(0, eq);
    if (!SECRET_KEY_PATTERN.test(name)) return pair;
    hits.push(`${path}?${name}`);
    return `${name}=${REDACTED}`;
  });
  return `${base}?${parts.join('&')}`;
}

// Returns { record, redacted: [field paths] } leaving the input untouched.
export function redactRecord(entityName, record) {
  const hits = [];
  const out = { ...record };

  for (const field of FIELD_STRIP[entityName] || []) {
    if (field in out) {
      delete out[field];
      hits.push(`${field} (stripped)`);
    }
  }

  for (const field of SECRET_FIELDS[entityName] || []) {
    if (out[field] != null && out[field] !== '') {
      out[field] = REDACTED;
      hits.push(field);
    }
  }

  for (const field of SECRET_BLOB_FIELDS[entityName] || []) {
    if (out[field] != null && out[field] !== '') out[field] = scrubBlob(out[field], hits, field);
  }

  for (const field of SECRET_URL_FIELDS[entityName] || []) {
    if (out[field] != null && out[field] !== '') out[field] = scrubUrl(out[field], hits, field);
  }

  return { record: out, redacted: hits };
}

// Rolls per record hits into a per entity re-entry checklist for the manifest,
// so the receiving app is told exactly what has to be typed back in by hand.
export function summariseRedactions(entityName, allHits) {
  const counts = new Map();
  for (const hit of allHits) counts.set(hit, (counts.get(hit) || 0) + 1);
  return [...counts.entries()]
    .map(([field, count]) => ({ entity: entityName, field, count }))
    .sort((a, b) => b.count - a.count);
}
