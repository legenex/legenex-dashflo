// Configuration recovery. Task C1.
//
// Requirement: recover existing buyers, suppliers, sources, campaigns, routes,
// destinations, caps, prices, schedules, mappings and response rules
// automatically where possible, and ask Bru only about unresolved exceptions
// and credential references.
//
// The point of this module is the second half of that sentence. Recovering
// what is already in the database is easy; the value is a truthful list of
// what is missing, ambiguous or unusable, so the Gate B packet contains only
// questions that code could not answer.
//
// This module decides nothing and writes nothing. It inspects and reports.

export const SEVERITY = {
  BLOCKER: 'blocker',
  QUESTION: 'question',
  INFO: 'info',
};

// One check per rule. Each returns a list of findings. A finding is either a
// blocker (a configured flow cannot run), a question (a human has to decide),
// or info (worth knowing, not worth asking about).
//
// `value` fields carry configuration identifiers only. No contact details and
// no credential values ever enter a finding, because this report becomes a
// Gate B artifact and Gate B explicitly forbids credential values.

function finding(severity, area, code, message, subject = null, value = null) {
  return { severity, area, code, message, subject, value };
}

// Whether a record is live enough for its gaps to matter.
//
// This has to be `active === true`, not `active !== false`, because the three
// entity schemas disagree on the default: Buyer.active defaults to false with
// status "draft", while Supplier.active and Campaign.active default to true.
// Under `active !== false` every buyer check would silently never fire, and the
// report would look clean because the rule was dead rather than because the
// configuration was good.
//
// `active` is the right field to read: the Buyer schema states that it is
// derived from status and that the live pipeline reads this boolean.
function isLive(record) {
  return record?.active === true;
}

export function checkBuyers(buyers = []) {
  const out = [];
  const codes = new Map();

  for (const b of buyers) {
    const label = b.company_name || b.name || b.id;

    if (!b.buyer_code) {
      out.push(finding(SEVERITY.BLOCKER, 'buyer', 'BUYER_NO_CODE',
        'Buyer has no buyer_code, so leads cannot be attributed to it by code.', b.id, label));
    } else {
      const key = String(b.buyer_code).trim().toLowerCase();
      if (codes.has(key)) {
        out.push(finding(SEVERITY.BLOCKER, 'buyer', 'BUYER_CODE_DUPLICATE',
          `buyer_code is used by more than one buyer, so identity resolution cannot pick one. Also held by ${codes.get(key)}.`,
          b.id, b.buyer_code));
      } else {
        codes.set(key, b.id);
      }
    }

    if (isLive(b) && !b.payment_provider) {
      out.push(finding(SEVERITY.QUESTION, 'buyer', 'BUYER_NO_PAYMENT_TERMS',
        'Active buyer has no payment provider recorded, so billing terms are unknown.', b.id, label));
    }
  }

  return out;
}

export function checkSuppliers(suppliers = [], apiKeys = []) {
  const out = [];
  const sids = new Map();
  const keyedSupplierIds = new Set(apiKeys.map((k) => k.supplier_id).filter(Boolean));
  const keyedSupplierNames = new Set(apiKeys.map((k) => k.supplier_name).filter(Boolean));

  for (const s of suppliers) {
    const label = s.name || s.id;

    if (!s.sid) {
      out.push(finding(SEVERITY.QUESTION, 'supplier', 'SUPPLIER_NO_SID',
        'Supplier has no sid, so its posting spec link cannot be built.', s.id, label));
    } else {
      const key = String(s.sid).trim().toLowerCase();
      if (sids.has(key)) {
        out.push(finding(SEVERITY.BLOCKER, 'supplier', 'SUPPLIER_SID_DUPLICATE',
          `sid is used by more than one supplier. Also held by ${sids.get(key)}.`, s.id, s.sid));
      } else {
        sids.set(key, s.id);
      }
    }

    if (isLive(s) && !keyedSupplierIds.has(s.id) && !keyedSupplierNames.has(s.name)) {
      out.push(finding(SEVERITY.BLOCKER, 'supplier', 'SUPPLIER_NO_API_KEY',
        'Active supplier has no API key, so it cannot post a lead.', s.id, label));
    }
  }

  return out;
}

export function checkCampaigns(campaigns = [], buyers = [], verticals = []) {
  const out = [];
  const buyerIds = new Set(buyers.map((b) => b.id));
  const verticalCodes = new Set(verticals.map((v) => v.code || v.name).filter(Boolean));

  for (const c of campaigns) {
    const label = c.name || c.id;

    if (c.vertical && verticalCodes.size > 0 && !verticalCodes.has(c.vertical)) {
      out.push(finding(SEVERITY.QUESTION, 'campaign', 'CAMPAIGN_UNKNOWN_VERTICAL',
        'Campaign names a vertical that does not exist.', c.id, c.vertical));
    }

    const linked = Array.isArray(c.buyer_ids) ? c.buyer_ids : [];
    for (const id of linked) {
      if (!buyerIds.has(id)) {
        out.push(finding(SEVERITY.BLOCKER, 'campaign', 'CAMPAIGN_DANGLING_BUYER',
          'Campaign routes to a buyer record that does not exist.', c.id, id));
      }
    }

    if (isLive(c) && linked.length === 0) {
      out.push(finding(SEVERITY.BLOCKER, 'campaign', 'CAMPAIGN_NO_BUYERS',
        'Active campaign has no buyers, so every lead it accepts is unsellable.', c.id, label));
    }

    if (isLive(c) && (c.price === undefined || c.price === null || c.price === '')) {
      out.push(finding(SEVERITY.QUESTION, 'campaign', 'CAMPAIGN_NO_PRICE',
        'Active campaign has no price, so revenue cannot be computed.', c.id, label));
    }
  }

  return out;
}

// Credential references that must exist before a configured integration works.
// Names only. Gate B forbids values, and this report is a Gate B artifact.
export function checkCredentialReferences(env = process.env, { dncConfigured = false } = {}) {
  const out = [];

  const required = [
    ['JWT_SECRET', 'Session signing. Production startup refuses the development fallback.'],
    ['MIGRATE_SOURCE_SECRET', 'Migration mirror endpoint. Fails closed when unset. Must be rotated: the previous value is in git history.'],
    ['PUBLIC_BASE_URL', 'Absolute links in outbound mail and onboarding.'],
  ];

  for (const [name, why] of required) {
    if (!env[name]) {
      out.push(finding(SEVERITY.QUESTION, 'credential', 'CREDENTIAL_REFERENCE_MISSING', why, name, null));
    }
  }

  if (dncConfigured && !env.DNC_HASH_KEY) {
    out.push(finding(SEVERITY.BLOCKER, 'credential', 'CREDENTIAL_REFERENCE_MISSING',
      'Do-not-contact entries exist but DNC_HASH_KEY is unset, so none of them can be matched.',
      'DNC_HASH_KEY', null));
  }

  return out;
}

// Run every check and group the result.
export function recoverConfiguration({
  buyers = [], suppliers = [], apiKeys = [], campaigns = [], verticals = [],
  dncEntries = [], env = process.env,
} = {}) {
  const findings = [
    ...checkBuyers(buyers),
    ...checkSuppliers(suppliers, apiKeys),
    ...checkCampaigns(campaigns, buyers, verticals),
    ...checkCredentialReferences(env, { dncConfigured: dncEntries.length > 0 }),
  ];

  const recovered = {
    buyers: buyers.length,
    suppliers: suppliers.length,
    api_keys: apiKeys.length,
    campaigns: campaigns.length,
    verticals: verticals.length,
    dnc_entries: dncEntries.length,
  };

  const bySeverity = { blocker: 0, question: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    recovered,
    findings,
    bySeverity,
    // The Gate B packet asks only about what code could not settle.
    ready_for_gate_b: bySeverity.blocker === 0,
  };
}

export default {
  SEVERITY,
  checkBuyers,
  checkSuppliers,
  checkCampaigns,
  checkCredentialReferences,
  recoverConfiguration,
};
