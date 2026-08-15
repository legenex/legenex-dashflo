// Buyer identity resolution. Task R1.
//
// The problem
// -----------
// `Lead.buyer_id` is overloaded. Its schema says "reference to the Buyer
// record", but across legacy imports, LeadByte feedback matching and native
// routing it has been written with three different things:
//
//   - a Buyer record id, which is what the schema claims
//   - a Buyer.buyer_code, the human facing short code
//   - a legacy LeadByte bid, carried over from the old system
//
// Any code that assumes one of those is wrong for the other two, and a report
// that groups by it silently splits one buyer into several. CLAUDE.md records
// this as a verified repository fact and requires an additive migration.
//
// The approach
// ------------
// Additive, as the requirements demand. `buyer_id` is not redefined and not
// deleted. Two new fields carry the resolved identity:
//
//   buyer_record_id  the Buyer record id, always
//   buyer_code       the Buyer.buyer_code, always
//
// New writes populate both. Old rows are backfilled. Readers move to the new
// fields over time, and `buyer_id` stays exactly as it is so nothing that
// currently reads it breaks during the transition.
//
// Anything that cannot be resolved is reported, never guessed. A lead attached
// to the wrong buyer is a delivery to the wrong customer and a charge to the
// wrong account, so an unresolved row goes on an exception report for a human.

export const RESOLUTION = {
  RECORD_ID: 'record_id',
  BUYER_CODE: 'buyer_code',
  LEGACY_BID: 'legacy_bid',
  NAME: 'name',
  UNRESOLVED: 'unresolved',
  AMBIGUOUS: 'ambiguous',
  EMPTY: 'empty',
};

// Build the lookup indexes once, then resolve many leads against them. Doing
// this per lead would be O(leads x buyers), which matters on a backfill of
// twelve months of history.
export function buildBuyerIndex(buyers = []) {
  const byRecordId = new Map();
  const byCode = new Map();
  const byLegacyBid = new Map();
  const byName = new Map();
  const ambiguous = { code: new Set(), legacy_bid: new Set(), name: new Set() };

  const norm = (v) => String(v ?? '').trim().toLowerCase();

  for (const buyer of buyers) {
    if (!buyer || !buyer.id) continue;
    byRecordId.set(String(buyer.id), buyer);

    for (const [value, map, key] of [
      [buyer.buyer_code, byCode, 'code'],
      [buyer.leadbyte_bid, byLegacyBid, 'legacy_bid'],
      [buyer.company_name || buyer.name, byName, 'name'],
    ]) {
      const k = norm(value);
      if (!k) continue;
      if (map.has(k) && map.get(k).id !== buyer.id) {
        // Two buyers claim the same code, bid or name. Resolving through it
        // would attach leads to whichever happened to load first, so the key
        // is poisoned and every lead using it becomes an exception.
        ambiguous[key].add(k);
      } else {
        map.set(k, buyer);
      }
    }
  }

  return { byRecordId, byCode, byLegacyBid, byName, ambiguous, norm };
}

// Resolve one lead's buyer.
//
// Order matters and is deliberate: the most specific and least collidable
// identifier first. A record id is unique by construction. A buyer code is
// unique by policy. A legacy bid is unique in the old system. A name is a last
// resort and is the only one that routinely collides, so it is tried last and
// its ambiguity is reported.
export function resolveBuyer(lead, index) {
  const { byRecordId, byCode, byLegacyBid, byName, ambiguous, norm } = index;

  const candidate = lead?.buyer_id;
  const key = norm(candidate);

  if (!key) {
    // No buyer on the lead at all. That is a normal state for a lead that was
    // never sold, so it is reported separately from a failed resolution.
    const nameKey = norm(lead?.buyer_name);
    if (!nameKey) {
      return { resolved: false, via: RESOLUTION.EMPTY, buyer: null };
    }
    if (ambiguous.name.has(nameKey)) {
      return { resolved: false, via: RESOLUTION.AMBIGUOUS, buyer: null, on: 'buyer_name' };
    }
    const byNameHit = byName.get(nameKey);
    if (byNameHit) return { resolved: true, via: RESOLUTION.NAME, buyer: byNameHit };
    return { resolved: false, via: RESOLUTION.UNRESOLVED, buyer: null };
  }

  // A record id is matched case sensitively, because ids are generated hex and
  // lowercasing one could in principle collide with a code.
  const exactRecord = byRecordId.get(String(candidate).trim());
  if (exactRecord) return { resolved: true, via: RESOLUTION.RECORD_ID, buyer: exactRecord };

  if (ambiguous.code.has(key)) {
    return { resolved: false, via: RESOLUTION.AMBIGUOUS, buyer: null, on: 'buyer_code' };
  }
  const codeHit = byCode.get(key);
  if (codeHit) return { resolved: true, via: RESOLUTION.BUYER_CODE, buyer: codeHit };

  if (ambiguous.legacy_bid.has(key)) {
    return { resolved: false, via: RESOLUTION.AMBIGUOUS, buyer: null, on: 'leadbyte_bid' };
  }
  const bidHit = byLegacyBid.get(key);
  if (bidHit) return { resolved: true, via: RESOLUTION.LEGACY_BID, buyer: bidHit };

  return { resolved: false, via: RESOLUTION.UNRESOLVED, buyer: null };
}

// The additive patch for a lead, or null when there is nothing to write.
//
// Never clears an existing value and never touches buyer_id. A lead that is
// already normalized produces null, which is what makes the backfill
// restartable: a second run over the same rows writes nothing.
export function normalizationPatch(lead, resolution) {
  if (!resolution.resolved) return null;

  const patch = {};
  if (lead.buyer_record_id !== resolution.buyer.id) {
    patch.buyer_record_id = resolution.buyer.id;
  }
  const code = resolution.buyer.buyer_code || '';
  if (code && lead.buyer_code !== code) {
    patch.buyer_code = code;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// Run the whole set and produce counts plus an exception list.
//
// The exception list carries lead ids and the unresolved key, never contact
// details, so the report can be handed to a human without becoming a PII
// artifact.
export function reconcile(leads = [], buyers = []) {
  const index = buildBuyerIndex(buyers);

  const counts = {
    total: leads.length,
    resolved: 0,
    already_normalized: 0,
    needs_write: 0,
    unresolved: 0,
    ambiguous: 0,
    no_buyer: 0,
  };
  const byMethod = {};
  const exceptions = [];
  const patches = [];

  for (const lead of leads) {
    const resolution = resolveBuyer(lead, index);
    byMethod[resolution.via] = (byMethod[resolution.via] || 0) + 1;

    if (resolution.resolved) {
      counts.resolved += 1;
      const patch = normalizationPatch(lead, resolution);
      if (patch) { counts.needs_write += 1; patches.push({ id: lead.id, patch }); }
      else counts.already_normalized += 1;
      continue;
    }

    if (resolution.via === RESOLUTION.EMPTY) { counts.no_buyer += 1; continue; }
    if (resolution.via === RESOLUTION.AMBIGUOUS) counts.ambiguous += 1;
    else counts.unresolved += 1;

    exceptions.push({
      lead_id: lead.id,
      reason: resolution.via,
      on: resolution.on || 'buyer_id',
      // The unresolved key itself, which is a buyer identifier and not
      // personal data. No contact fields are copied into the report.
      value: lead.buyer_id || lead.buyer_name || null,
    });
  }

  return { counts, byMethod, exceptions, patches };
}

export default {
  RESOLUTION,
  buildBuyerIndex,
  resolveBuyer,
  normalizationPatch,
  reconcile,
};
