import { describe, it, expect } from 'vitest';
import { makeInMemoryAttemptStore } from './deliveryStore.js';

describe('deliveryStore claimLease (status-aware CAS)', () => {
  it('claims an unleased attempt with no requiredStatus given', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'error' });
    expect(await store.claimLease(a.id, 'w1', 1000, 30000)).toBe(true);
  });

  it('honors requiredStatus: claims only when the row is still in that status', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'error' });
    expect(await store.claimLease(a.id, 'w1', 1000, 30000, 'error')).toBe(true);
  });

  it('refuses the claim when the row has already moved to a different status than required', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'error' });
    // A concurrent completion (e.g. a manual retry) settled this attempt
    // between the retry worker's listDue() read and this claim call.
    await store.updateAttempt(a.id, { status: 'accepted', lease_until: null });
    expect(await store.claimLease(a.id, 'w2', 1000, 30000, 'error')).toBe(false);
  });

  it('still claims an expired lease when status is unchanged', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'error' });
    await store.updateAttempt(a.id, { lease_until: new Date(500).toISOString(), leased_by: 'dead', lease_version: 1 });
    expect(await store.claimLease(a.id, 'w2', 1000, 30000, 'error')).toBe(true);
  });

  it('refuses a second concurrent claim while the lease is still active', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'error' });
    expect(await store.claimLease(a.id, 'w1', 1000, 30000, 'error')).toBe(true);
    expect(await store.claimLease(a.id, 'w2', 1001, 30000, 'error')).toBe(false);
  });

  it('claimLease with no requiredStatus can claim a terminal (e.g. dead_letter) row for a manual retry', async () => {
    const store = makeInMemoryAttemptStore();
    const a = await store.createAttempt({ lead_id: 'L1', destination_id: 'd1', status: 'dead_letter', attempt_number: 5 });
    expect(await store.claimLease(a.id, 'manual', 2000, 30000)).toBe(true);
  });
});
