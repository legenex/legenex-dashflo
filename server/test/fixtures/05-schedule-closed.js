// Fixture 5 of 13: schedule closed.
//
// evaluateMember reads a pre-resolved boolean (m.withinSchedule) rather than
// a raw schedule object - the caller resolves it upstream in production
// (snapshot.js). To exercise the REAL resolver rather than hand-computing
// `false`, this fixture calls the real isWithinSchedule(nowMs, schedule) from
// schedule.js/the generated bundle and passes its actual return value through,
// exactly as snapshot.js does.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

// A Tuesday 09:00-17:00 America/New_York window.
const SCHEDULE = { timezone: 'America/New_York', windows: [{ days: [2], start: '09:00', end: '17:00' }] };
// A Saturday, well outside the window, in the same timezone.
export const NOW_MS = Date.parse('2026-08-15T15:00:00Z'); // Sat Aug 15 2026, 11:00 America/New_York

export const fixture = {
  id: 'schedule-closed',
  name: 'Schedule closed',
  description: 'Buyer only operates Tuesdays 09:00-17:00 America/New_York; the lead arrives on a Saturday.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550105' },
  nowMs: NOW_MS,
  schedule: SCHEDULE,
  build(base, withinSchedule) {
    const member = buildMember('rm_5b83c0f1', { buyerId: 'buyer_88ff77ee', withinSchedule });
    return { groups: [buildGroup('grp_sched4400', [member])] };
  },
  expected: {
    reasonCode: 'OUTSIDE_SCHEDULE',
    runStatus: 'no_eligible_member',
    callCount: 0,
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
