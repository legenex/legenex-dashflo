import { describe, it, expect } from 'vitest';
import {
  LEAD_STATUS, LEAD_STATUS_VALUES, LEAD_STATUS_LABEL, LEGACY_FINAL_STATUS,
  resolveLeadStatus, leadStatusLabel, matchesLeadView, isLeadStatus,
  DEFAULT_LEAD_STATUSES, STATUS_TO_TRIGGER, buildTriggerOptions, statusLabelFor,
} from './leadStatus.js';

// forge-pack/CONTRACT.md D1: the operator-facing enum becomes exactly seven
// lowercase values. This is the client-side half of W3-UI-STATUS's own
// acceptance criterion ("No client file references a retired status value"):
// the vocabulary this module exposes must BE the seven values, not the
// twelve-value set W2-STATUS retired five of.
describe('LEAD_STATUS: exactly the seven D1 values', () => {
  it('has exactly seven values', () => {
    expect(LEAD_STATUS_VALUES).toHaveLength(7);
  });

  it('is exactly queued, rejected, disqualified, unsold, sold, returned, converted', () => {
    expect(new Set(LEAD_STATUS_VALUES)).toEqual(new Set([
      'queued', 'rejected', 'disqualified', 'unsold', 'sold', 'returned', 'converted',
    ]));
  });

  it('never includes a retired value', () => {
    const retired = ['processing', 'qualified', 'duplicate', 'error', 'fake'];
    for (const r of retired) expect(LEAD_STATUS_VALUES).not.toContain(r);
  });

  it('every value has a display label', () => {
    for (const v of LEAD_STATUS_VALUES) expect(LEAD_STATUS_LABEL[v]).toBeTruthy();
  });
});

describe('resolveLeadStatus: prefers the server-provided lead_status', () => {
  it('reads lead_status when it is one of the seven, case-insensitively', () => {
    expect(resolveLeadStatus({ lead_status: 'sold' })).toBe(LEAD_STATUS.SOLD);
    expect(resolveLeadStatus({ lead_status: 'SOLD' })).toBe(LEAD_STATUS.SOLD);
  });

  it('ignores a nonsense lead_status and falls back to final_status', () => {
    expect(resolveLeadStatus({ lead_status: 'not-a-real-value', final_status: 'Sold' })).toBe(LEAD_STATUS.SOLD);
  });

  it('never reads final_status when a valid lead_status is present, even a contradictory one', () => {
    // Not re-deriving a precedence order here, just proving lead_status wins:
    // this is what "read lead_status where the server now provides them, not
    // final_status" means in practice.
    expect(resolveLeadStatus({ lead_status: 'unsold', final_status: 'Sold' })).toBe(LEAD_STATUS.UNSOLD);
  });

  it('maps every one of D4\'s twelve legacy final_status values onto the correct seven-value status when lead_status is absent', () => {
    const table = {
      [LEGACY_FINAL_STATUS.PROCESSING]: LEAD_STATUS.QUEUED,
      [LEGACY_FINAL_STATUS.QUALIFIED]: LEAD_STATUS.QUEUED,
      [LEGACY_FINAL_STATUS.ERROR]: LEAD_STATUS.QUEUED,
      [LEGACY_FINAL_STATUS.QUEUED]: LEAD_STATUS.QUEUED,
      [LEGACY_FINAL_STATUS.DUPLICATE]: LEAD_STATUS.REJECTED,
      [LEGACY_FINAL_STATUS.FAKE]: LEAD_STATUS.REJECTED,
      [LEGACY_FINAL_STATUS.REJECTED]: LEAD_STATUS.REJECTED,
      [LEGACY_FINAL_STATUS.DISQUALIFIED]: LEAD_STATUS.DISQUALIFIED,
      [LEGACY_FINAL_STATUS.UNSOLD]: LEAD_STATUS.UNSOLD,
      [LEGACY_FINAL_STATUS.SOLD]: LEAD_STATUS.SOLD,
      [LEGACY_FINAL_STATUS.RETURNED]: LEAD_STATUS.RETURNED,
      [LEGACY_FINAL_STATUS.CONVERTED]: LEAD_STATUS.CONVERTED,
    };
    for (const [legacy, expected] of Object.entries(table)) {
      expect(resolveLeadStatus({ final_status: legacy })).toBe(expected);
    }
  });

  it('returns null for a lead with neither field set to anything recognisable', () => {
    expect(resolveLeadStatus({})).toBeNull();
    expect(resolveLeadStatus(null)).toBeNull();
  });

  it('leadStatusLabel renders the title-case label for the resolved status', () => {
    expect(leadStatusLabel({ lead_status: 'unsold' })).toBe('Unsold');
    expect(leadStatusLabel({ final_status: LEGACY_FINAL_STATUS.DUPLICATE })).toBe('Rejected');
    expect(leadStatusLabel({})).toBeNull();
  });
});

describe('matchesLeadView: single definition shared by LeadsTable and LeadsNav', () => {
  it('all matches every lead regardless of status', () => {
    expect(matchesLeadView({ lead_status: 'sold' }, 'all')).toBe(true);
    expect(matchesLeadView({}, 'all')).toBe(true);
  });

  it('a legacy Duplicate lead now matches the rejected tab, not its own tab', () => {
    expect(matchesLeadView({ final_status: LEGACY_FINAL_STATUS.DUPLICATE }, 'rejected')).toBe(true);
  });

  it('a legacy Error lead now matches the queued tab, never the disqualified tab', () => {
    expect(matchesLeadView({ final_status: LEGACY_FINAL_STATUS.ERROR }, 'queued')).toBe(true);
    expect(matchesLeadView({ final_status: LEGACY_FINAL_STATUS.ERROR }, 'disqualified')).toBe(false);
  });

  it('disqualified still matches on the leadbyte_record_status regex signal, unrelated to the retired vocabulary', () => {
    expect(matchesLeadView({ leadbyte_record_status: 'DQ - bad zip' }, 'disqualified')).toBe(true);
  });

  it('sold/unsold/returned/converted match only their own canonical status', () => {
    expect(matchesLeadView({ lead_status: 'sold' }, 'sold')).toBe(true);
    expect(matchesLeadView({ lead_status: 'sold' }, 'unsold')).toBe(false);
    expect(matchesLeadView({ lead_status: 'converted' }, 'converted')).toBe(true);
  });
});

describe('Destinations trigger mapping: seven-value vocabulary, canonical keys', () => {
  it('DEFAULT_LEAD_STATUSES carries only survivors of D4, no retired label', () => {
    expect(DEFAULT_LEAD_STATUSES).toEqual(['Queued', 'Rejected', 'Disqualified', 'Unsold', 'Sold', 'Returned', 'Converted']);
  });

  it('every canonical trigger key matches server/src/lib/leadStatus.js\'s TRIGGER export spelling', () => {
    expect(Object.values(STATUS_TO_TRIGGER)).toEqual(
      expect.arrayContaining(['on_qualified', 'on_queued', 'on_rejected', 'on_disqualified', 'on_unsold', 'on_sold', 'on_returned', 'on_converted'])
    );
  });

  it('buildTriggerOptions falls back to the seven-value default set plus guaranteed extras', () => {
    const options = buildTriggerOptions([]);
    const values = options.map((o) => o.value);
    expect(values).toContain('on_sold');
    expect(values).toContain('on_24m_lead');
    expect(options.find((o) => o.label === 'Queued')).toBeTruthy();
  });

  it('statusLabelFor resolves a canonical key and falls back to a slug for an unknown one', () => {
    expect(statusLabelFor('on_sold')).toBe('Sold');
    expect(statusLabelFor('on_something_custom')).toBe('something custom');
  });

  it('isLeadStatus is case-insensitive and rejects a retired value', () => {
    expect(isLeadStatus('SOLD')).toBe(true);
    expect(isLeadStatus(LEGACY_FINAL_STATUS.QUALIFIED)).toBe(false);
  });
});
