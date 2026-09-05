// Fixture 8 of 13: duplicate.
//
// The first (and only reachable) destination responds HTTP 409, classifyResponse's
// real, unconditional duplicate rule (deliveryAttempt.js: `if (httpStatus === 409)
// return ATTEMPT_STATUS.DUPLICATE`). distributeLead's terminalOnDuplicate default
// (true) means the waterfall stops here - a second, lower-priority buyer is
// configured but must never be contacted, proving a duplicate response is
// terminal, not a cue to keep shopping the lead around.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'duplicate',
  name: 'Duplicate',
  description: 'The buyer reports this lead as a duplicate (HTTP 409); routing stops there.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550108' },
  build(base) {
    const m1 = buildMember('rm_44d5e6f7', {
      buyerId: 'buyer_dupe0001', priority: 1,
      delivery: { targetUrl: `${base}/duplicate?bid=BYR-401` },
    });
    const m2 = buildMember('rm_88a9b0c1', {
      buyerId: 'buyer_dupe0002', priority: 2,
      delivery: { targetUrl: `${base}/accept?price=70&bid=BYR-402` },
    });
    return { groups: [buildGroup('grp_dupe5511', [m1, m2])] };
  },
  expected: {
    reasonCode: 'duplicate',
    runStatus: 'duplicate',
    callCount: 1, // m2 must never be contacted once m1 reports duplicate
    winnerMemberId: 'rm_44d5e6f7',
    // processLead.js's real native-path mapping for RUN.DUPLICATE
    // (processLead.js:2464-2474): lead_status 'duplicate', final_status
    // 'Duplicate', code 'DUPLICATE'.
    leadStatus: 'duplicate',
    finalStatus: 'Duplicate',
    code: 'DUPLICATE',
  },
};
