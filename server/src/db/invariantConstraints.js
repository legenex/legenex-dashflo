// Additive database constraints that close application-code-only enforcement
// gaps found by the W7-INVARIANTS audit. See docs/INVARIANTS.md for the full
// invariant-by-invariant record this module implements one line of.
//
// Pattern, deliberately copied from server/src/db/schema.js's own
// lead_flags_write_once trigger (W1-FLAGS): every statement here is
// CREATE ... IF NOT EXISTS, safe to run on every boot against a fresh
// database or an existing one, and touches no existing row. Rollback for
// each block is named in its own comment, so reversing one is a single DROP,
// never a data migration.
//
// This module is intentionally separate from schema.js rather than added to
// it: W7-INVARIANTS' file ownership is docs/INVARIANTS.md,
// server/src/db/invariantConstraints.js and the two test files named in
// forge-pack/03-plan/WORK-UNITS.yaml, and schema.js already carries two other
// units' work (W1-FLAGS, W2-STATUS) landed immediately before this one.
// Wiring ensureInvariantConstraints() into the boot sequence
// (server/src/index.js, right after ensureSchema()) is one import and one
// call and is left as a follow-up rather than done here, for the same
// file-ownership reason. Until that follow-up lands, this module's
// constraints exist and are exercised by server/test/capRace.test.js and
// server/test/idempotency.test.js, which call it directly, but are not yet
// applied to a real boot. See docs/INVARIANTS.md, "Follow-up needed outside
// this unit's file ownership".

import { pool } from './pool.js';
import { entitySchemas, tableName } from '../schemas/index.js';

export async function ensureInvariantConstraints() {
  await ensureCapReservationUniqueness();
}

// ── CapReservation: (idempotency_key, route_member_id) uniqueness ─────────
//
// The gap, verbatim from docs/INVARIANTS.md's audit: CapReservation.json's own
// comment claims "Uniqueness (idempotency_key, route_member_id) guarantees no
// double-consume on retry", but nothing in server/src/db/schema.js (read in
// full for this audit) creates any such constraint. CapReservation is an
// ordinary e_* JSONB entity table with only the generic id primary key every
// entity gets.
//
// What actually keeps two rows from being written today is entirely in
// application code: client/src/lib/distribution/reservation.js's reserve()
// only ever calls store.putReservation() after it has already won an atomic
// claim via store.claim() (capStore.js), and that claim is itself backed by a
// REAL constraint: the claim key is a CapCounter row, and CapCounter.scope_key
// carries the unique index schema.js adds directly below the comment this
// index mirrors. So the current protection is real, but it is one call site
// (reserve()) away from being bypassable: a second writer that calls
// putReservation() directly, a script, or a future code path that reserves
// capacity a different way would not go through that claim at all, and
// nothing at the database layer would stop it from writing a second
// CapReservation row for the same (idempotency_key, route_member_id) pair,
// which is precisely a duplicate commercial send or sale, and precisely the
// class of failure invariant 3 and Section 7 both name.
//
// This closes it the same way CapCounter.scope_key already does: a real
// unique index on the JSONB fields, so the guarantee holds even against a
// caller that never heard of reserve().
//
// Rollback: DROP INDEX IF EXISTS e_cap_reservation_idem_member_idx;
async function ensureCapReservationUniqueness() {
  if (!entitySchemas.CapReservation) return; // entity not present in this build; nothing to protect
  const table = tableName('CapReservation');

  // Unlike CapCounter's own rollout, this module has no live-production
  // verification that zero rows already violate the constraint it is about to
  // add (that check was done by hand, once, before CapCounter's index shipped
  // - see schema.js's comment on it - and this audit has no equivalent
  // production access). A bare CREATE UNIQUE INDEX over data that already
  // holds a duplicate pair would fail outright and, since this runs at boot,
  // would stop the application from starting. Checking first means an
  // existing violation is reported loudly and left exactly as it was, rather
  // than turning an unrelated deploy into an outage.
  const { rows: violations } = await pool.query(`
    SELECT data->>'idempotency_key' AS idempotency_key,
           data->>'route_member_id' AS route_member_id,
           count(*)::int AS row_count
      FROM ${table}
     WHERE data->>'idempotency_key' IS NOT NULL
       AND data->>'route_member_id' IS NOT NULL
     GROUP BY 1, 2
    HAVING count(*) > 1
     LIMIT 5
  `);

  if (violations.length > 0) {
    console.error(
      '[invariantConstraints] Refusing to add the CapReservation uniqueness index: '
      + `${violations.length} existing (idempotency_key, route_member_id) pair(s) already have `
      + `more than one row (first: idempotency_key=${violations[0].idempotency_key} `
      + `route_member_id=${violations[0].route_member_id} count=${violations[0].row_count}). `
      + 'This is the exact gap docs/INVARIANTS.md documents. Resolve the duplicate rows (keep the '
      + 'earliest, per created_date) before this index can be created safely.',
    );
    return;
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_idem_member_idx
      ON ${table} ((data->>'idempotency_key'), (data->>'route_member_id'))
      WHERE data->>'idempotency_key' IS NOT NULL AND data->>'route_member_id' IS NOT NULL;
  `);
}

export default ensureInvariantConstraints;
