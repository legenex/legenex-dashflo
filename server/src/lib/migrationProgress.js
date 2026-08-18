// Progress for a running migration import.
//
// A migration package is uploaded in one request and processed inside that same
// request, which for a 100 MB owner export legitimately takes minutes. The
// browser cannot see inside that request, so before this existed the panel had
// one spinner and one sentence for the entire server side of the operation.
//
// This is deliberately the smallest mechanism that produces real numbers: an
// in-memory map the import writes counts into, and a polled read endpoint. No
// queue, no broker, no database table. Progress is disposable by nature; if the
// process restarts mid-import the import is gone too, so there is nothing worth
// persisting.
//
// What a record may contain is fixed by shape: a stage name and integers. The
// import reports "decrypting, 42 of 67 chunks", never what a chunk held. A
// record never carries the passphrase, a decrypted value, a record field, a
// filename or an error detail beyond a stable code, because this endpoint is
// polled and its answers are the easiest thing in the system to leak by
// accident.
//
// Records are owner scoped and read back only by the user who created them, so
// one operator cannot watch another's import.

const TTL_MS = 15 * 60 * 1000;
const MAX_RECORDS = 64;
const SWEEP_EVERY = 25;

// stage -> the share of the server side that is finished when it begins.
// These are honest boundaries between phases that actually exist in
// migrationImport.js, not a smooth fake ramp. Within `decrypting`, which is the
// long one, the percentage comes from real chunk counts.
const STAGE_FLOOR = {
  received: 0.02,
  parsing: 0.05,
  validating_envelope: 0.10,
  deriving_key: 0.14,
  decrypting: 0.20,
  validating: 0.80,
  building_preview: 0.92,
  applying: 0.92,
  complete: 1,
};
const DECRYPT_SPAN = STAGE_FLOOR.validating - STAGE_FLOOR.decrypting;

export const MIGRATION_STAGES = Object.freeze(Object.keys(STAGE_FLOOR));

const records = new Map();
let writes = 0;

function sweep(now = Date.now()) {
  for (const [id, record] of records) {
    if (now - record.updated_at > TTL_MS) records.delete(id);
  }
  // Bounded regardless of TTL, so a burst cannot grow this without limit.
  while (records.size > MAX_RECORDS) {
    const oldest = [...records.entries()].sort((a, b) => a[1].updated_at - b[1].updated_at)[0];
    if (!oldest) break;
    records.delete(oldest[0]);
  }
}

// A progress id is client generated so the browser can poll before the upload
// response arrives. It is accepted only in this shape, and it identifies a
// record that is still owner scoped on read, so guessing one reveals nothing.
export function isValidProgressId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function percentOf(record) {
  const floor = STAGE_FLOOR[record.stage] ?? 0;
  if (record.stage !== 'decrypting' || !record.total_chunks) return Math.round(floor * 100);
  const share = Math.min(record.processed_chunks / record.total_chunks, 1);
  return Math.round((floor + (share * DECRYPT_SPAN)) * 100);
}

export function startProgress({ id, userId, mode, kind, bytes = 0 }) {
  if (!isValidProgressId(id) || !userId) return null;
  writes += 1;
  const record = {
    id,
    user_id: String(userId),
    mode: String(mode || 'preview'),
    kind: String(kind || 'ordinary'),
    stage: 'received',
    total_bytes: Number(bytes) || 0,
    total_chunks: 0,
    processed_chunks: 0,
    done: false,
    failed: false,
    code: null,
    updated_at: Date.now(),
  };
  records.set(id, record);
  // Swept after inserting, not before, so the ceiling holds for the map as it
  // actually stands rather than for the map one record ago.
  if (writes % SWEEP_EVERY === 0 || records.size > MAX_RECORDS) sweep();
  return record;
}

// The handle handed to the importer. It can only move a record forward through
// the shapes above; it cannot put arbitrary content into one.
export function progressSink(id) {
  if (!id || !records.has(id)) return null;
  return {
    stage(name, extra = {}) {
      const record = records.get(id);
      if (!record || record.done) return;
      if (!Object.hasOwn(STAGE_FLOOR, name)) return;
      record.stage = name;
      if (Number.isInteger(extra.total_chunks)) record.total_chunks = extra.total_chunks;
      if (Number.isInteger(extra.processed_chunks)) record.processed_chunks = extra.processed_chunks;
      record.updated_at = Date.now();
    },
    chunk(processed) {
      const record = records.get(id);
      if (!record || record.done) return;
      if (!Number.isInteger(processed)) return;
      record.processed_chunks = processed;
      record.updated_at = Date.now();
    },
  };
}

export function finishProgress(id, { failed = false, code = null } = {}) {
  const record = records.get(id);
  if (!record) return;
  record.done = true;
  record.failed = Boolean(failed);
  // Only the stable error code, never a message. The response body carries the
  // words; this endpoint carries the state.
  record.code = code ? String(code).slice(0, 40) : null;
  if (!failed) record.stage = 'complete';
  record.updated_at = Date.now();
}

// Read is owner scoped: a record answers only to the user that created it.
export function readProgress(id, userId) {
  const record = records.get(id);
  if (!record || !userId || record.user_id !== String(userId)) return null;
  return {
    id: record.id,
    mode: record.mode,
    kind: record.kind,
    stage: record.stage,
    percent: percentOf(record),
    processed_chunks: record.processed_chunks,
    total_chunks: record.total_chunks,
    total_bytes: record.total_bytes,
    done: record.done,
    failed: record.failed,
    code: record.code,
  };
}

export function resetProgressForTests() {
  records.clear();
  writes = 0;
}
