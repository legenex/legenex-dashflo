import { describe, it, expect } from 'vitest';
import { isLegacyMember, isConfiguredMember, destinationLabel } from './memberDestination.js';

/* Regression coverage for the production bug where a campaign's Routing tab
 * showed ~12 rows that looked like real configured deliveries but were
 * actually orphan RouteMembers: sub_delivery_id: null, no real Delivery or
 * SubDelivery behind them, looking real only because destination_name held
 * the buyer's own company name (typed into "Buyer name" on BuyerConfigModal).
 *
 * destinationLabel used to trust destination_name unconditionally whenever it
 * was non-empty. isConfiguredMember is the check that closes that hole:
 * "configured" means sub_delivery_id resolves to an active SubDelivery whose
 * parent Delivery is also active. destinationLabel now only trusts
 * destination_name / the sub-delivery name for a configured member (or a
 * legitimate legacy member); everything else renders as "Not configured".
 */

const activeDelivery = { id: 'del-1', status: 'active' };
const pausedDelivery = { id: 'del-2', status: 'paused' };
const draftDelivery = { id: 'del-3', status: 'draft' };
const archivedDelivery = { id: 'del-4', status: 'archived' };

const activeSub = { id: 'sub-1', delivery_id: 'del-1', active: true, name: 'Primary endpoint' };
const inactiveSub = { id: 'sub-2', delivery_id: 'del-1', active: false, name: 'Disabled endpoint' };
const subOnPausedDelivery = { id: 'sub-3', delivery_id: 'del-2', active: true, name: 'Paused-parent endpoint' };
const subOnDraftDelivery = { id: 'sub-4', delivery_id: 'del-3', active: true, name: 'Draft-parent endpoint' };
const subOnArchivedDelivery = { id: 'sub-5', delivery_id: 'del-4', active: true, name: 'Archived-parent endpoint' };

const subById = Object.fromEntries(
  [activeSub, inactiveSub, subOnPausedDelivery, subOnDraftDelivery, subOnArchivedDelivery].map((s) => [s.id, s]),
);
const deliveryById = Object.fromEntries(
  [activeDelivery, pausedDelivery, draftDelivery, archivedDelivery].map((d) => [d.id, d]),
);

describe('isConfiguredMember', () => {
  it('is true for a member with a real active sub_delivery_id and an active parent Delivery', () => {
    const m = { id: 'm1', buyer_id: 'b1', sub_delivery_id: 'sub-1' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(true);
  });

  it('is false for a member with no sub_delivery_id at all (the orphan shape)', () => {
    const m = { id: 'm2', buyer_id: 'b1', sub_delivery_id: null, destination_name: 'Walker Advertising' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when sub_delivery_id does not resolve to any known SubDelivery', () => {
    const m = { id: 'm3', buyer_id: 'b1', sub_delivery_id: 'sub-does-not-exist' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when the SubDelivery is inactive', () => {
    const m = { id: 'm4', buyer_id: 'b1', sub_delivery_id: 'sub-2' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when the SubDelivery is active but the parent Delivery is paused', () => {
    const m = { id: 'm5', buyer_id: 'b1', sub_delivery_id: 'sub-3' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when the SubDelivery is active but the parent Delivery is draft', () => {
    const m = { id: 'm6', buyer_id: 'b1', sub_delivery_id: 'sub-4' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when the SubDelivery is active but the parent Delivery is archived', () => {
    const m = { id: 'm7', buyer_id: 'b1', sub_delivery_id: 'sub-5' };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
  });

  it('is false when the parent Delivery id cannot be resolved at all', () => {
    const orphanSub = { id: 'sub-6', delivery_id: 'del-missing', active: true, name: 'Dangling' };
    const localSubById = { ...subById, 'sub-6': orphanSub };
    const m = { id: 'm8', buyer_id: 'b1', sub_delivery_id: 'sub-6' };
    expect(isConfiguredMember(m, localSubById, deliveryById)).toBe(false);
  });
});

describe('destinationLabel', () => {
  it('shows the real name for a configured member (destination_name wins when set)', () => {
    const m = { id: 'm1', buyer_id: 'b1', sub_delivery_id: 'sub-1', destination_name: 'Acme Legal Intake' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Acme Legal Intake');
  });

  it('falls back to the sub-delivery name for a configured member with no destination_name', () => {
    const m = { id: 'm1b', buyer_id: 'b1', sub_delivery_id: 'sub-1' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Primary endpoint');
  });

  // This is the exact regression shape from the production bug report: a
  // buyer's own company name sitting in destination_name on a RouteMember
  // that has no real sub_delivery_id at all.
  it('reports "Not configured" for a member with destination_name set but NO real sub_delivery_id, regardless of the name', () => {
    const m = {
      id: 'orphan-1',
      buyer_id: 'walker-buyer',
      sub_delivery_id: null,
      destination_name: 'Walker Advertising',
    };
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('reports "Not configured" when sub_delivery_id points at an inactive SubDelivery, even with destination_name set', () => {
    const m = { id: 'm4', buyer_id: 'b1', sub_delivery_id: 'sub-2', destination_name: 'Looks Real LLC' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('reports "Not configured" when the SubDelivery is active but the parent Delivery is not active (paused)', () => {
    const m = { id: 'm5', buyer_id: 'b1', sub_delivery_id: 'sub-3', destination_name: 'Also Looks Real Inc' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('reports "Not configured" when the SubDelivery is active but the parent Delivery is not active (draft)', () => {
    const m = { id: 'm6', buyer_id: 'b1', sub_delivery_id: 'sub-4' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('reports "Not configured" when the SubDelivery is active but the parent Delivery is not active (archived)', () => {
    const m = { id: 'm7', buyer_id: 'b1', sub_delivery_id: 'sub-5' };
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('the existing legacy-member case is unchanged: an inline-config member with no sub_delivery_id shows its destination_name, or "Legacy destination" if unset', () => {
    const withName = {
      id: 'legacy-1', buyer_id: 'b1', sub_delivery_id: null, destination_name: 'Legacy Buyer Co',
      delivery_config: JSON.stringify({ url: 'https://buyer.example/api' }),
    };
    expect(isLegacyMember(withName)).toBe(true);
    expect(destinationLabel(withName, subById, deliveryById)).toBe('Legacy Buyer Co');

    const withoutName = {
      id: 'legacy-2', buyer_id: 'b1', sub_delivery_id: null,
      ping_config: JSON.stringify({ url: 'https://buyer.example/ping' }),
    };
    expect(isLegacyMember(withoutName)).toBe(true);
    expect(destinationLabel(withoutName, subById, deliveryById)).toBe('Legacy destination');
  });

  it('a member with neither a resolvable sub_delivery_id nor inline config, and no destination_name, is "Not configured"', () => {
    const m = { id: 'bare-1', buyer_id: 'b1' };
    expect(isLegacyMember(m)).toBe(false);
    expect(isConfiguredMember(m, subById, deliveryById)).toBe(false);
    expect(destinationLabel(m, subById, deliveryById)).toBe('Not configured');
  });

  it('does not throw when subById/deliveryById are missing entirely', () => {
    const m = { id: 'm1', buyer_id: 'b1', sub_delivery_id: 'sub-1', destination_name: 'X' };
    expect(isConfiguredMember(m)).toBe(false);
    expect(destinationLabel(m)).toBe('Not configured');
  });
});

describe('isLegacyMember (unchanged)', () => {
  it('is false when sub_delivery_id is set, even with inline config also present', () => {
    const m = { sub_delivery_id: 'sub-1', delivery_config: JSON.stringify({ url: 'x' }) };
    expect(isLegacyMember(m)).toBe(false);
  });

  it('is false when there is no sub_delivery_id and no meaningful inline config', () => {
    expect(isLegacyMember({ sub_delivery_id: null, delivery_config: '', ping_config: '{}' })).toBe(false);
    expect(isLegacyMember({})).toBe(false);
    expect(isLegacyMember(null)).toBe(false);
  });

  it('is true when there is no sub_delivery_id and either inline config is meaningfully set', () => {
    expect(isLegacyMember({ delivery_config: JSON.stringify({ url: 'https://x' }) })).toBe(true);
    expect(isLegacyMember({ ping_config: JSON.stringify({ url: 'https://x' }) })).toBe(true);
  });
});
