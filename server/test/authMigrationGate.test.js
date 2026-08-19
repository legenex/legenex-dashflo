// The authentication gate for the Base44 production import.
//
// One question: can the Base44 owner bundle damage the authentication system
// that is already working in production? Production currently holds a single
// owner whose credential carries both a password hash and a linked Google
// subject, so "damage" means any of:
//
//   - unlinking or overwriting that Google subject
//   - invalidating that password credential
//   - creating a second owner
//   - creating a duplicate account for the same person
//   - turning an imported historical record into a live way to authenticate
//
// These run against a real disposable PostgreSQL because the properties under
// test are database properties: a natural-key collision query, a UNIQUE index
// on the Google subject, and what an UPDATE does to a row that already exists.
// A double would pass while the real thing behaved differently.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const TEST_DB = 'dashflo_auth_migration_gate_test';
const MAINTENANCE_DB = 'postgres';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

const pg = (await import('pg')).default;

async function maintenance(sql) {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function canReachPostgres() {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const reachable = await canReachPostgres();

const OWNER_EMAIL = 'owner@dashflo.test';
const OWNER_USER_ID = 'dashflo-owner-1';
const OWNER_GOOGLE_SUB = 'google-sub-owner-1';
const OWNER_PASSWORD_HASH = '$2a$10$abcdefghijklmnopqrstuv';

// A Base44 owner bundle carrying User and Invitation records. Written as an
// ordinary export rather than the encrypted one: the encryption is proven
// elsewhere, and what matters here is what the importer does with the records
// once they are decrypted.
function base44Bundle(entities) {
  return {
    manifest: {
      bundle_version: 1,
      source_app: 'legenex-dashboard',
      exported_at: '2026-08-17T12:00:00.000Z',
      counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
    },
    entities,
  };
}

describe.skipIf(!reachable)('Base44 import against the live authentication system', () => {
  let pool;
  let runMigrationImport;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    ({ runMigrationImport } = await import('../src/lib/migrationImport.js'));
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => {});
  });

  // Rebuild the production shape before each test: one owner, password hash
  // plus a linked Google subject, and the matching User entity row.
  beforeEach(async () => {
    await pool.query('TRUNCATE auth_credentials');
    await pool.query('TRUNCATE e_user, e_invitation, e_supplier, e_buyer');
    // Provenance decides whether a DashFlo record was created here or carried
    // in, and whether a target already has a source origin. Leaving it behind
    // between tests would make each one depend on the last.
    await pool.query('TRUNCATE base44_record_provenance').catch(() => {});
    await pool.query(
      `INSERT INTO auth_credentials (user_id, email, password_hash, google_sub, google_email, google_linked_at, disabled)
       VALUES ($1, $2, $3, $4, $2, now(), false)`,
      [OWNER_USER_ID, OWNER_EMAIL, OWNER_PASSWORD_HASH, OWNER_GOOGLE_SUB],
    );
    await pool.query(
      `INSERT INTO e_user (id, data) VALUES ($1, $2::jsonb)`,
      [OWNER_USER_ID, JSON.stringify({ email: OWNER_EMAIL, full_name: 'Production Owner', role: 'admin', base_role: 'owner' })],
    );
  });

  async function importBundle(entities) {
    return runMigrationImport({
      kind: 'ordinary',
      mode: 'apply',
      bundle: base44Bundle(entities),
      user: { id: OWNER_USER_ID, email: OWNER_EMAIL, base_role: 'owner' },
      confirmed: true,
    });
  }

  async function previewBundle(entities) {
    return runMigrationImport({
      kind: 'ordinary',
      mode: 'preview',
      bundle: base44Bundle(entities),
      user: { id: OWNER_USER_ID, email: OWNER_EMAIL, base_role: 'owner' },
    });
  }

  async function credential(userId = OWNER_USER_ID) {
    const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE user_id = $1', [userId]);
    return rows[0] || null;
  }

  // ── The credential store is out of the importer's reach ──────────────────

  it('writes nothing to auth_credentials, because the importer only touches entity tables', async () => {
    const before = await pool.query('SELECT * FROM auth_credentials ORDER BY user_id');

    await importBundle({
      User: [
        { id: 'base44-user-9', email: 'newcomer@dashflo.test', full_name: 'Newcomer', role: 'admin', base_role: 'admin', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    const after = await pool.query('SELECT * FROM auth_credentials ORDER BY user_id');
    expect(after.rows).toEqual(before.rows);
    // An imported User has no credential, so it cannot authenticate at all.
    expect(await credential('base44-user-9')).toBeNull();
  });

  it('leaves the production owner credential exactly as it was', async () => {
    // The same person, arriving under the id DashFlo already uses. This is the
    // shape a reconciliation import takes once ids are aligned.
    await importBundle({
      User: [
        { id: OWNER_USER_ID, email: OWNER_EMAIL, full_name: 'Owner From Base44', role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    const cred = await credential();
    expect(cred.google_sub, 'the linked Google identity must survive').toBe(OWNER_GOOGLE_SUB);
    expect(cred.password_hash, 'the password credential must survive').toBe(OWNER_PASSWORD_HASH);
    expect(cred.disabled).toBe(false);
    expect(cred.email).toBe(OWNER_EMAIL);
  });

  it('cannot populate a Google subject from an imported email address', async () => {
    // A Base44 email is not proof that the person controls a Google account.
    await importBundle({
      User: [
        { id: 'base44-user-10', email: 'someone@dashflo.test', google_sub: 'attacker-supplied-sub', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    const { rows } = await pool.query('SELECT user_id, google_sub FROM auth_credentials');
    expect(rows).toHaveLength(1);
    expect(rows[0].google_sub).toBe(OWNER_GOOGLE_SUB);
    // Even if the bundle carries the field, it lands in the entity blob where
    // no authentication path reads it.
    const { rows: entityRows } = await pool.query("SELECT data->>'google_sub' AS sub FROM e_user WHERE id = 'base44-user-10'");
    expect(await credential('base44-user-10')).toBeNull();
    expect(entityRows[0].sub).toBe('attacker-supplied-sub');
  });

  // ── Identity collisions ──────────────────────────────────────────────────
  //
  // A source user whose email matches an account DashFlo already has is the
  // same person, and the only safe outcomes are "become that account" or
  // "stop". Creating a second account is what must never happen.
  //
  // This used to stop, permanently: the email match was reported as an
  // unresolvable collision and the whole package was refused, which meant no
  // real package could ever be applied. It now resolves onto the existing
  // account, and the properties below are what make that safe rather than
  // merely convenient.

  it('matches a source user onto the existing DashFlo account instead of creating a second one', async () => {
    const report = await previewBundle({
      User: [
        { id: 'base44-owner-different-id', email: OWNER_EMAIL, full_name: 'Owner From Base44', role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    expect(report.can_apply, 'a natural key match is a resolution, not a blocker').toBe(true);
    expect(report.id_collisions.length).toBeGreaterThan(0);
    expect(report.id_collisions[0]).toMatchObject({
      entity: 'User',
      source_id: 'base44-owner-different-id',
      natural_key_field: 'email',
      resolved_target_id: OWNER_USER_ID,
      severity: 'resolved',
    });
    expect(report.resolved_id_remaps).toContainEqual(expect.objectContaining({
      entity: 'User', source_id: 'base44-owner-different-id', target_id: OWNER_USER_ID, matched_by: 'natural_key',
    }));
    expect(report.reconciliation.id_remaps).toBe(1);
    expect(report.reconciliation.planned_creates).toBe(0);
  });

  it('applies that match onto the existing row and leaves the credential and the role alone', async () => {
    // Age the DashFlo row so the source record is the newer of the two. The
    // locally-newer path is covered separately; what is under test here is what
    // an ordinary in-order import does to an account it matched.
    await pool.query('UPDATE e_user SET updated_date = $2 WHERE id = $1', [OWNER_USER_ID, '2026-08-01T00:00:00.000Z']);

    const applied = await importBundle({
      User: [
        { id: 'base44-owner-different-id', email: OWNER_EMAIL, full_name: 'Owner From Base44', role: 'user', base_role: 'manager', timezone: 'America/Regina', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });
    expect(applied.result).toBe('success');
    expect(applied.applied.created).toBe(0);
    expect(applied.applied.remapped).toBe(1);

    // Exactly one account, and it is the one that was already there.
    const { rows } = await pool.query('SELECT id, data FROM e_user');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(OWNER_USER_ID);

    // middleware/auth.js reads the caller straight off this row, so these three
    // fields are the live authorization. The source record asked for manager
    // and it did not get it.
    expect(rows[0].data.base_role).toBe('owner');
    expect(rows[0].data.role).toBe('admin');
    // Everything that is not authorization still migrates.
    expect(rows[0].data.timezone).toBe('America/Regina');
    expect(rows[0].data.full_name).toBe('Owner From Base44');

    const cred = await credential();
    expect(cred.google_sub).toBe(OWNER_GOOGLE_SUB);
    expect(cred.password_hash).toBe(OWNER_PASSWORD_HASH);
    expect(cred.disabled).toBe(false);

    // The move from source id to DashFlo id is durable, so a later run resolves
    // the same way and an audit can follow the record back.
    const { rows: provenance } = await pool.query(
      "SELECT base44_id, dashflo_id FROM base44_record_provenance WHERE entity = 'User'",
    );
    expect(provenance).toEqual([{ base44_id: 'base44-owner-different-id', dashflo_id: OWNER_USER_ID }]);
  });

  it('matches regardless of how the address is capitalised', async () => {
    // The natural key comparison must not be case sensitive. If it is, a
    // capitalised source address becomes a second account for the same person.
    const report = await previewBundle({
      User: [
        { id: 'base44-owner-cased', email: OWNER_EMAIL.toUpperCase(), full_name: 'Owner', role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    expect(report.can_apply).toBe(true);
    expect(report.reconciliation.planned_creates).toBe(0);
    expect(report.id_collisions[0]).toMatchObject({ resolved_target_id: OWNER_USER_ID, severity: 'resolved' });
  });

  it('matches when the source address carries stray whitespace', async () => {
    const report = await previewBundle({
      User: [
        { id: 'base44-owner-spaced', email: `  ${OWNER_EMAIL} `, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });
    expect(report.can_apply).toBe(true);
    expect(report.reconciliation.planned_creates).toBe(0);
    expect(report.id_collisions[0]).toMatchObject({ resolved_target_id: OWNER_USER_ID });
  });

  it('fails closed when two source users claim the same DashFlo account', async () => {
    // Two records folding to one email cannot both become the same account, and
    // picking one arbitrarily hands somebody another person's account.
    const report = await previewBundle({
      User: [
        { id: 'base44-owner-a', email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
        { id: 'base44-owner-b', email: OWNER_EMAIL.toUpperCase(), role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    expect(report.can_apply).toBe(false);
    expect(report.unresolved_count).toBe(1);
    expect(report.hard_blockers.some((b) => b.kind === 'id_collision' && b.source_id === 'base44-owner-b')).toBe(true);
  });

  it('fails closed when two DashFlo accounts already answer to one address', async () => {
    await pool.query(
      'INSERT INTO e_user (id, data) VALUES ($1, $2::jsonb)',
      ['dashflo-owner-duplicate', JSON.stringify({ email: OWNER_EMAIL.toUpperCase(), role: 'user', base_role: 'manager' })],
    );

    const report = await previewBundle({
      User: [
        { id: 'base44-owner-different-id', email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    expect(report.can_apply, 'two candidate targets is not a choice the importer may make').toBe(false);
    expect(report.id_collisions[0]).toMatchObject({ collision_type: 'ambiguous_target_match', severity: 'blocker' });
  });

  it('fails closed when the DashFlo account was already migrated from a different source record', async () => {
    await importBundle({
      User: [
        { id: 'base44-owner-first', email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    });

    const report = await previewBundle({
      User: [
        { id: 'base44-owner-second', email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-18T12:00:00.000Z' },
      ],
    });

    expect(report.can_apply).toBe(false);
    expect(report.id_collisions[0]).toMatchObject({ collision_type: 'target_already_migrated', severity: 'blocker' });
  });

  it('refuses to apply a bundle that still has an unresolved blocker, even when confirmed', async () => {
    await pool.query(
      'INSERT INTO e_user (id, data) VALUES ($1, $2::jsonb)',
      ['dashflo-owner-duplicate', JSON.stringify({ email: OWNER_EMAIL.toUpperCase(), role: 'user', base_role: 'manager' })],
    );

    await expect(importBundle({
      User: [
        { id: 'base44-owner-different-id', email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    })).rejects.toThrow(/cannot be applied/i);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_user');
    expect(rows[0].n).toBe(2);
  });

  // ── Imported historical records must not become live authorization ───────

  it('does not let an imported Base44 invitation authorize a fresh Google account', async () => {
    // The chain that matters: a historical invitation lands in the entity
    // table, and the Google login path treats a pending invitation as an
    // operator's decision to grant access. An invitation created years ago in
    // another system is not this instance's decision, and one carrying an
    // elevated role would mint that role.
    await importBundle({
      Invitation: [
        {
          id: 'base44-invite-1',
          email: 'stranger@dashflo.test',
          role: 'admin',
          base_role: 'owner',
          status: 'pending',
          updated_date: '2026-08-17T12:00:00.000Z',
        },
      ],
    });

    const { rows } = await pool.query("SELECT data FROM e_invitation WHERE id = 'base44-invite-1'");
    expect(rows, 'the historical record itself is preserved as history').toHaveLength(1);

    const { decideGoogleLink, LINK_ACTION } = await import('../src/lib/googleAccountLink.js');
    const decision = decideGoogleLink({
      identity: { sub: 'google-sub-stranger', email: 'stranger@dashflo.test' },
      credentialBySub: null,
      credentialsByEmail: [],
      invitation: { id: 'base44-invite-1', ...rows[0].data },
      allowSelfSignup: false,
    });

    expect(
      decision.action,
      'an imported invitation must not activate an account, least of all an owner',
    ).toBe(LINK_ACTION.REFUSE);
  });

  it('still honours an invitation this instance issued itself', async () => {
    const { decideGoogleLink, LINK_ACTION } = await import('../src/lib/googleAccountLink.js');
    const decision = decideGoogleLink({
      identity: { sub: 'google-sub-invited', email: 'invited@dashflo.test' },
      invitation: { id: 'local-invite-1', email: 'invited@dashflo.test', status: 'pending', role: 'user', base_role: 'manager' },
      allowSelfSignup: false,
    });
    expect(decision.action).toBe(LINK_ACTION.ACTIVATE_INVITATION);
    expect(decision.baseRole).toBe('manager');
  });

  it('drops invitation acceptance tokens on import', async () => {
    await importBundle({
      Invitation: [
        {
          id: 'base44-invite-2',
          email: 'tokened@dashflo.test',
          status: 'pending',
          token: 'legacy-accept-token',
          invite_token: 'another-token',
          accept_token: 'third-token',
          updated_date: '2026-08-17T12:00:00.000Z',
        },
      ],
    });
    const { rows } = await pool.query("SELECT data FROM e_invitation WHERE id = 'base44-invite-2'");
    const stored = JSON.stringify(rows[0].data);
    expect(stored).not.toContain('legacy-accept-token');
    expect(stored).not.toContain('another-token');
    expect(stored).not.toContain('third-token');
  });

  it('drops password hashes and session material from imported users', async () => {
    await importBundle({
      User: [{
        id: 'base44-user-11',
        email: 'hashed@dashflo.test',
        password: 'plaintext-should-never-arrive',
        password_hash: '$2a$10$base44hashvalue',
        session_token: 'base44-session',
        refresh_token: 'base44-refresh',
        updated_date: '2026-08-17T12:00:00.000Z',
      }],
    });
    const { rows } = await pool.query("SELECT data FROM e_user WHERE id = 'base44-user-11'");
    const stored = JSON.stringify(rows[0].data);
    for (const secret of ['plaintext-should-never-arrive', '$2a$10$base44hashvalue', 'base44-session', 'base44-refresh']) {
      expect(stored, secret).not.toContain(secret);
    }
    expect(rows[0].data).not.toHaveProperty('password_hash');
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('creates zero duplicate users or credentials across three identical runs', async () => {
    const entities = {
      User: [
        { id: 'base44-user-a', email: 'alpha@dashflo.test', full_name: 'Alpha', role: 'user', base_role: 'manager', updated_date: '2026-08-17T12:00:00.000Z' },
        { id: 'base44-user-b', email: 'beta@dashflo.test', full_name: 'Beta', role: 'user', base_role: 'manager', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
      Invitation: [
        { id: 'base44-invite-3', email: 'gamma@dashflo.test', status: 'accepted', role: 'user', updated_date: '2026-08-17T12:00:00.000Z' },
      ],
    };

    const first = await importBundle(entities);
    expect(first.applied.created).toBe(3);

    const counts = async () => {
      const users = await pool.query('SELECT count(*)::int AS n FROM e_user');
      const invites = await pool.query('SELECT count(*)::int AS n FROM e_invitation');
      const creds = await pool.query('SELECT count(*)::int AS n FROM auth_credentials');
      return { users: users.rows[0].n, invites: invites.rows[0].n, creds: creds.rows[0].n };
    };

    const afterFirst = await counts();
    expect(afterFirst).toEqual({ users: 3, invites: 1, creds: 1 });

    const second = await importBundle(entities);
    expect(second.applied.created).toBe(0);
    expect(await counts()).toEqual(afterFirst);

    const third = await importBundle(entities);
    expect(third.applied.created).toBe(0);
    expect(await counts()).toEqual(afterFirst);

    // The owner credential is untouched by any of the three runs.
    const cred = await credential();
    expect(cred.google_sub).toBe(OWNER_GOOGLE_SUB);
    expect(cred.password_hash).toBe(OWNER_PASSWORD_HASH);
  });

  it('does not reactivate a disabled account', async () => {
    await pool.query('UPDATE auth_credentials SET disabled = true WHERE user_id = $1', [OWNER_USER_ID]);
    await importBundle({
      User: [{ id: OWNER_USER_ID, email: OWNER_EMAIL, role: 'admin', base_role: 'owner', active: true, disabled: false, updated_date: '2030-01-01T00:00:00.000Z' }],
    });
    const cred = await credential();
    expect(cred.disabled, 'disabled lives on the credential, which the importer never writes').toBe(true);
  });

  it('preserves a locally newer role rather than taking the Base44 one', async () => {
    // The DashFlo record is newer, so the migration conflict policy keeps it.
    await pool.query(
      `UPDATE e_user SET data = jsonb_set(data, '{base_role}', '"manager"'), updated_date = $2 WHERE id = $1`,
      [OWNER_USER_ID, '2030-01-01T00:00:00.000Z'],
    );
    const result = await importBundle({
      User: [{ id: OWNER_USER_ID, email: OWNER_EMAIL, role: 'admin', base_role: 'owner', updated_date: '2026-08-17T12:00:00.000Z' }],
    });
    expect(result.applied.conflicts).toBeGreaterThan(0);
    const { rows } = await pool.query("SELECT data->>'base_role' AS r FROM e_user WHERE id = $1", [OWNER_USER_ID]);
    expect(rows[0].r, 'a newer local role must not be overwritten by the bundle').toBe('manager');
  });
});
