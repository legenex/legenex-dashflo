import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  finishProgress, progressSink, resetProgressForTests, startProgress,
} from '../src/lib/migrationProgress.js';

/* The progress endpoint, over HTTP.
 *
 * This is a new read surface on an owner-only feature, so the interesting cases
 * are the ones where it must say nothing: an unauthenticated caller, a caller
 * who is not the owner, and an authenticated operator asking for somebody else's
 * run. An unknown or foreign id answers 404 rather than 403, so the endpoint
 * does not confirm that another operator's migration exists.
 *
 * No database is needed here: records are seeded directly through the store, and
 * the import path itself is covered by the round trip and legacy iteration
 * suites.
 */

const OWNER = { id: 'owner-1', email: 'owner@example.test', base_role: 'owner' };
const OTHER_OWNER = { id: 'owner-2', email: 'owner2@example.test', base_role: 'owner' };
const ADMIN = { id: 'admin-1', email: 'admin@example.test', base_role: 'admin' };

const ID = 'c'.repeat(32);

describe('migration progress endpoint', () => {
  let server;
  let baseUrl;
  let currentUser;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const { default: migrationRoutes } = await import('../src/routes/migrations.js');
    const app = express();
    app.use((req, _res, next) => { req.user = currentUser ? { ...currentUser } : undefined; next(); });
    app.use('/api/migrations', migrationRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetProgressForTests();
    currentUser = OWNER;
  });

  const get = async (id) => {
    const res = await fetch(`${baseUrl}/api/migrations/progress/${id}`);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };

  it('returns the live state to the owner that started the run', async () => {
    startProgress({ id: ID, userId: OWNER.id, mode: 'preview', kind: 'owner', bytes: 4096 });
    progressSink(ID).stage('decrypting', { total_chunks: 80, processed_chunks: 0 });
    progressSink(ID).chunk(42);

    const { status, body } = await get(ID);
    expect(status).toBe(200);
    expect(body.stage).toBe('decrypting');
    expect(body.processed_chunks).toBe(42);
    expect(body.total_chunks).toBe(80);
    expect(body.percent).toBeGreaterThan(0);
    expect(body.done).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    startProgress({ id: ID, userId: OWNER.id, mode: 'preview', kind: 'owner' });
    currentUser = null;
    const { status } = await get(ID);
    expect(status).toBe(401);
  });

  it('does not leak another operator run, and does not confirm it exists', async () => {
    startProgress({ id: ID, userId: OTHER_OWNER.id, mode: 'preview', kind: 'owner' });
    const { status, body } = await get(ID);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(OTHER_OWNER.id);
  });

  it('refuses a non owner asking about an owner migration', async () => {
    startProgress({ id: ID, userId: ADMIN.id, mode: 'preview', kind: 'owner' });
    currentUser = ADMIN;
    const { status } = await get(ID);
    expect(status).toBe(403);
  });

  it('refuses a buyer or supplier scoped account outright', async () => {
    startProgress({ id: ID, userId: 'buyer-1', mode: 'preview', kind: 'ordinary' });
    currentUser = { id: 'buyer-1', base_role: 'buyer', linked_buyer_id: 'buyer-1' };
    const { status } = await get(ID);
    expect(status).toBe(403);
  });

  it('rejects a malformed progress id without touching the store', async () => {
    for (const bad of ['nope', '..%2F..%2Fetc%2Fpasswd', 'A'.repeat(32), '1'.repeat(64)]) {
      const { status } = await get(bad);
      expect(status).toBe(400);
    }
  });

  it('answers 404 for an id that was never started', async () => {
    const { status } = await get('d'.repeat(32));
    expect(status).toBe(404);
  });

  it('reports a finished run as done', async () => {
    startProgress({ id: ID, userId: OWNER.id, mode: 'preview', kind: 'owner' });
    finishProgress(ID, { failed: false });
    const { body } = await get(ID);
    expect(body.done).toBe(true);
    expect(body.failed).toBe(false);
    expect(body.percent).toBe(100);
  });

  it('reports a failed run with its stable code and no message', async () => {
    startProgress({ id: ID, userId: OWNER.id, mode: 'preview', kind: 'owner' });
    progressSink(ID).stage('deriving_key');
    finishProgress(ID, { failed: true, code: 'decrypt_failed' });
    const { body } = await get(ID);
    expect(body.failed).toBe(true);
    expect(body.code).toBe('decrypt_failed');
    expect(body.stage).toBe('deriving_key');
    expect(body).not.toHaveProperty('error');
    expect(body).not.toHaveProperty('message');
  });

  it('never returns a passphrase, a filename or package content', async () => {
    startProgress({ id: ID, userId: OWNER.id, mode: 'preview', kind: 'owner', bytes: 130739398 });
    progressSink(ID).stage('decrypting', { total_chunks: 80 });
    const { body } = await get(ID);
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('passphrase');
    expect(serialized).not.toContain('.enc');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('salt');
  });
});
