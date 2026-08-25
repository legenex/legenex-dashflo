// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: src/lib/distribution/backend-entry.js and its imports.
// Regenerate: node scripts/generate-backend-engine.mjs
// canonical-engine-sha256: e57c654f17480b441be7f773715b773cc6a6c1b25efb8bd1b1914e3049f782df
// src/lib/distribution/engine.js
var REASON = {
  ELIGIBLE: "ELIGIBLE",
  BUYER_LIFECYCLE_INELIGIBLE: "BUYER_LIFECYCLE_INELIGIBLE",
  MEMBER_INACTIVE: "MEMBER_INACTIVE",
  OUTSIDE_SCHEDULE: "OUTSIDE_SCHEDULE",
  FILTER_STATE: "FILTER_STATE",
  FILTER_ZIP: "FILTER_ZIP",
  FILTER_COUNTY: "FILTER_COUNTY",
  FILTER_VERTICAL: "FILTER_VERTICAL",
  FILTER_BRAND: "FILTER_BRAND",
  FILTER_SUPPLIER: "FILTER_SUPPLIER",
  FILTER_SOURCE: "FILTER_SOURCE",
  FILTER_LEAD_TYPE: "FILTER_LEAD_TYPE",
  FILTER_ACCIDENT_DATE: "FILTER_ACCIDENT_DATE",
  MISSING_REQUIRED_FIELDS: "MISSING_REQUIRED_FIELDS",
  QUALIFICATION_FAILED: "QUALIFICATION_FAILED",
  SUPPRESSED: "SUPPRESSED",
  CAP_TOTAL: "CAP_TOTAL",
  CAP_HOURLY: "CAP_HOURLY",
  CAP_DAILY: "CAP_DAILY",
  CAP_WEEKLY: "CAP_WEEKLY",
  CAP_MONTHLY: "CAP_MONTHLY",
  LOW_BALANCE: "LOW_BALANCE",
  OVER_CREDIT_LIMIT: "OVER_CREDIT_LIMIT",
  DESTINATION_UNHEALTHY: "DESTINATION_UNHEALTHY",
  BELOW_RESERVE: "BELOW_RESERVE",
  NO_ELIGIBLE_MEMBER: "NO_ELIGIBLE_MEMBER"
};
var TRUSTEDFORM_RE = /^https?:\/\/cert\.trustedform\.com\/[0-9a-fA-F]{40}(\?.*)?$/;
function isValidTrustedForm(url) {
  return typeof url === "string" && TRUSTEDFORM_RE.test(url.trim());
}
function missingRequiredFields(data, required) {
  const d = data || {};
  return (required || []).filter((f) => {
    const v = d[f];
    return v === void 0 || v === null || String(v).trim() === "";
  });
}
function passesListFilter(filterList, value) {
  if (!Array.isArray(filterList) || filterList.length === 0) return true;
  const v = String(value ?? "").trim().toLowerCase();
  return filterList.some((f) => String(f).trim().toLowerCase() === v);
}
function withinTrailingMonths(dateVal, months, nowMs) {
  const t = Date.parse(String(dateVal ?? "").trim());
  if (Number.isNaN(t)) return false;
  const cutoff = nowMs - Number(months) * 30 * 864e5;
  return t >= cutoff && t <= nowMs;
}
var CAP_WINDOWS = [
  ["total", REASON.CAP_TOTAL],
  ["hourly", REASON.CAP_HOURLY],
  ["daily", REASON.CAP_DAILY],
  ["weekly", REASON.CAP_WEEKLY],
  ["monthly", REASON.CAP_MONTHLY]
];
function exhaustedCap(caps) {
  const c = caps || {};
  for (const [key, reason] of CAP_WINDOWS) {
    const w = c[key];
    if (w && w.limit != null && Number(w.count || 0) + 1 > Number(w.limit)) {
      return reason;
    }
  }
  return null;
}
function evaluateMember(member, lead, opts = {}) {
  const m = member || {};
  const l = lead || {};
  const buyer = m.buyer || {};
  if (m.active === false) return fail(REASON.MEMBER_INACTIVE);
  const status = String(buyer.status || "").toLowerCase();
  const lifecycleOk = status === "active" && buyer.active === true;
  if (!lifecycleOk) return fail(REASON.BUYER_LIFECYCLE_INELIGIBLE);
  if (m.withinSchedule === false) return fail(REASON.OUTSIDE_SCHEDULE);
  const f = m.filters || {};
  if (!passesListFilter(f.states, l.state)) return fail(REASON.FILTER_STATE);
  if (!passesListFilter(f.lead_types, l.lead_type)) return fail(REASON.FILTER_LEAD_TYPE);
  if (f.accident_within_months != null && opts.nowMs != null && !withinTrailingMonths(l.accident_date, f.accident_within_months, opts.nowMs)) {
    return fail(REASON.FILTER_ACCIDENT_DATE);
  }
  if (!passesListFilter(f.zips, l.zip)) return fail(REASON.FILTER_ZIP);
  if (!passesListFilter(f.counties, l.county)) return fail(REASON.FILTER_COUNTY);
  if (!passesListFilter(f.verticals, l.vertical)) return fail(REASON.FILTER_VERTICAL);
  if (!passesListFilter(f.brands, l.brand)) return fail(REASON.FILTER_BRAND);
  if (!passesListFilter(f.suppliers, l.supplier)) return fail(REASON.FILTER_SUPPLIER);
  if (!passesListFilter(f.sources, l.source)) return fail(REASON.FILTER_SOURCE);
  if (Array.isArray(f.required_fields) && f.required_fields.length > 0 && missingRequiredFields(l, f.required_fields).length > 0) {
    return fail(REASON.MISSING_REQUIRED_FIELDS);
  }
  if (m.conditions && typeof opts.evalConditions === "function") {
    if (!opts.evalConditions(m.conditions, l)) return fail(REASON.QUALIFICATION_FAILED);
  }
  if (Array.isArray(m.suppression) && matchesSuppression(m.suppression, l)) {
    return fail(REASON.SUPPRESSED);
  }
  const cap = exhaustedCap(m.caps);
  if (cap) return fail(cap);
  const price = resolvePrice(m);
  const wallet = m.wallet;
  if (wallet && wallet.enforce !== false) {
    if (wallet.mode === "prepaid" && Number(wallet.balance || 0) < price) {
      return fail(REASON.LOW_BALANCE);
    }
    if (wallet.mode === "postpaid") {
      const projected = Number(wallet.outstanding || 0) + price;
      if (wallet.creditLimit != null && projected > Number(wallet.creditLimit)) {
        return fail(REASON.OVER_CREDIT_LIMIT);
      }
    }
  }
  if (m.health && m.health.blocked) return fail(REASON.DESTINATION_UNHEALTHY);
  if (opts.enforceReserve && m.reservePrice != null && price < Number(m.reservePrice)) {
    return fail(REASON.BELOW_RESERVE);
  }
  return { eligible: true, reason: REASON.ELIGIBLE };
}
function fail(reason) {
  return { eligible: false, reason };
}
function matchesSuppression(list, lead) {
  const email = String(lead.email || "").trim().toLowerCase();
  const phone = String(lead.mobile || lead.phone || "").replace(/\D/g, "");
  return list.some((s) => {
    const v = String(s || "").trim().toLowerCase();
    return email && v === email || phone && v.replace(/\D/g, "") === phone;
  });
}
function resolvePrice(member) {
  const m = member || {};
  if (m.priceMode === "auction" && m.bid != null) return Number(m.bid);
  if (m.price != null) return Number(m.price);
  if (m.fixedPrice != null) return Number(m.fixedPrice);
  return 0;
}
function selectPriority(members) {
  if (!members.length) return null;
  return [...members].sort(
    (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || String(a.id).localeCompare(String(b.id))
  )[0];
}
function selectWeighted(members, seed) {
  if (!members.length) return null;
  const weights = members.map((m) => Math.max(0, Number(m.weight ?? 1)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return selectPriority(members);
  const r = hashToUnit(String(seed || "")) * total;
  let acc = 0;
  for (let i = 0; i < members.length; i++) {
    acc += weights[i];
    if (r < acc) return members[i];
  }
  return members[members.length - 1];
}
function selectRoundRobin(members, cursor) {
  if (!members.length) return { member: null, nextCursor: cursor || 0 };
  const ordered = [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = ((Number(cursor) || 0) % ordered.length + ordered.length) % ordered.length;
  return { member: ordered[idx], nextCursor: (idx + 1) % ordered.length };
}
function selectAuction(members) {
  if (!members.length) return null;
  return [...members].sort(
    (a, b) => resolvePrice(b) - resolvePrice(a) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || String(a.id).localeCompare(String(b.id))
  )[0];
}
function selectHybrid(members, weights = {}) {
  if (!members.length) return null;
  const priceW = weights.price ?? 0.5;
  const prioW = weights.priority ?? 0.5;
  const prices = members.map(resolvePrice);
  const maxPrice = Math.max(1, ...prices);
  const priorities = members.map((m) => m.priority ?? 1);
  const maxPrio = Math.max(1, ...priorities);
  const scored = members.map((m, i) => ({
    m,
    // higher price is better; lower priority number is better -> invert priority
    score: priceW * (prices[i] / maxPrice) + prioW * (1 - (priorities[i] - 1) / maxPrio)
  }));
  scored.sort((a, b) => b.score - a.score || String(a.m.id).localeCompare(String(b.m.id)));
  return scored[0].m;
}
function routeWaterfall(groups, lead, ctx = {}) {
  const trace = [];
  const orderedGroups = [...groups || []].sort(
    (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
  );
  const rrOut = {};
  for (const group of orderedGroups) {
    if (group.active === false) continue;
    const evaluated = (group.members || []).map((m) => {
      const res = evaluateMember(m, lead, {
        enforceReserve: group.method === "auction",
        evalConditions: ctx.evalConditions,
        nowMs: ctx.nowMs
      });
      return { memberId: m.id, eligible: res.eligible, reason: res.reason, price: resolvePrice(m) };
    });
    trace.push({ groupId: group.id, method: group.method, candidates: evaluated });
    const eligible = (group.members || []).filter(
      (m) => evaluated.find((e) => e.memberId === m.id)?.eligible
    );
    if (!eligible.length) continue;
    let winner = null;
    switch (group.method) {
      case "weighted":
        winner = selectWeighted(eligible, ctx.idempotencyKey);
        break;
      case "round_robin": {
        const rr = selectRoundRobin(eligible, (ctx.rrCursors || {})[group.id]);
        winner = rr.member;
        rrOut[group.id] = rr.nextCursor;
        break;
      }
      case "auction":
        winner = selectAuction(eligible);
        break;
      case "hybrid":
        winner = selectHybrid(eligible, group.weights);
        break;
      case "priority":
      default:
        winner = selectPriority(eligible);
    }
    if (winner) {
      return {
        winner,
        groupId: group.id,
        method: group.method,
        configHash: group.configHash || null,
        price: resolvePrice(winner),
        fallthroughPath: orderedGroups.slice(0, orderedGroups.indexOf(group)).map((g) => g.id),
        rrCursors: rrOut,
        trace
      };
    }
  }
  return { winner: null, reason: REASON.NO_ELIGIBLE_MEMBER, rrCursors: rrOut, trace };
}
function capScopeKey(memberId, window, windowStart) {
  return `route_member:${memberId}:${window}:${window === "total" ? "all" : windowStart}`;
}
function capWindowStart(nowMs, window, tzOffsetMinutes = 0) {
  const local = new Date(nowMs + tzOffsetMinutes * 6e4);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  let startLocalMs;
  switch (window) {
    case "hourly":
      startLocalMs = Date.UTC(y, mo, d, local.getUTCHours());
      break;
    case "weekly": {
      const dow = local.getUTCDay();
      startLocalMs = Date.UTC(y, mo, d) - dow * 864e5;
      break;
    }
    case "monthly":
      startLocalMs = Date.UTC(y, mo, 1);
      break;
    case "daily":
    default:
      startLocalMs = Date.UTC(y, mo, d);
  }
  return new Date(startLocalMs - tzOffsetMinutes * 6e4).toISOString();
}
async function idempotencyKey({ supplierKeyId, dedupFields = {}, campaignId = "" }) {
  const keys = Object.keys(dedupFields).sort();
  const stable = keys.map((k) => `${k}=${String(dedupFields[k]).trim().toLowerCase()}`).join("&");
  const material = `${supplierKeyId || ""}:${stable}:${campaignId}`;
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var DEFAULT_SECRET_KEYS = [
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
  "password",
  "secret",
  "token",
  "bearer",
  "stripe",
  "card",
  "cvv",
  "ssn"
];
function redact(obj, secretKeys = DEFAULT_SECRET_KEYS) {
  const keys = secretKeys.map((k) => k.toLowerCase());
  const seen = /* @__PURE__ */ new WeakSet();
  const walk = (v) => {
    if (v == null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = keys.some((s) => k.toLowerCase().includes(s)) ? "[redacted]" : walk(val);
    }
    return out;
  };
  return walk(obj);
}
function hashToUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1e6 / 1e6;
}

// src/lib/distribution/conditions.js
var OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "matches",
  "exists",
  "not_exists",
  "within_months"
];
function asNumber(v) {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : NaN;
}
function asString(v) {
  return String(v ?? "").trim().toLowerCase();
}
function asList(v) {
  if (Array.isArray(v)) return v.map(asString);
  return asString(v).split(",").map((s) => s.trim()).filter(Boolean);
}
function asDateMs(v) {
  if (v == null || v === "") return NaN;
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}
function evalLeaf(leaf, data, ctx = {}) {
  const raw = (data || {})[leaf.field];
  const val = leaf.value;
  switch (leaf.operator) {
    case "exists":
      return raw !== void 0 && raw !== null && String(raw).trim() !== "";
    case "not_exists":
      return raw === void 0 || raw === null || String(raw).trim() === "";
    case "equals":
      return asString(raw) === asString(val);
    case "not_equals":
      return asString(raw) !== asString(val);
    case "contains":
      return asString(raw).includes(asString(val));
    case "not_contains":
      return !asString(raw).includes(asString(val));
    case "in":
      return asList(val).includes(asString(raw));
    case "not_in":
      return !asList(val).includes(asString(raw));
    case "gt":
      return asNumber(raw) > asNumber(val);
    case "gte":
      return asNumber(raw) >= asNumber(val);
    case "lt":
      return asNumber(raw) < asNumber(val);
    case "lte":
      return asNumber(raw) <= asNumber(val);
    case "between": {
      const [lo, hi] = Array.isArray(val) ? val : asList(val);
      const n = asNumber(raw);
      return n >= asNumber(lo) && n <= asNumber(hi);
    }
    case "matches": {
      try {
        return new RegExp(String(val), "i").test(String(raw ?? ""));
      } catch {
        return false;
      }
    }
    case "within_months": {
      const t = asDateMs(raw);
      if (Number.isNaN(t) || ctx.nowMs == null) return false;
      const months = asNumber(val);
      const cutoff = ctx.nowMs - months * 30 * 864e5;
      return t >= cutoff && t <= ctx.nowMs;
    }
    default:
      return false;
  }
}
function evalConditionTree(node, data, ctx = {}) {
  if (!node) return true;
  if (Array.isArray(node)) return node.every((c) => evalConditionTree(c, data, ctx));
  if (node.op === "and") return (node.children || []).every((c) => evalConditionTree(c, data, ctx));
  if (node.op === "or") return (node.children || []).some((c) => evalConditionTree(c, data, ctx));
  if (node.field && node.operator) return evalLeaf(node, data, ctx);
  return true;
}

// src/lib/distribution/schedule.js
var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function wallClock(nowMs, timeZone = "UTC") {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = DOW[get("weekday")] ?? 0;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get("minute"), 10);
  return { dow, minutes: hour * 60 + minute };
}
function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function isWithinSchedule(nowMs, schedule, fallbackTz) {
  if (!schedule || !Array.isArray(schedule.windows) || schedule.windows.length === 0) return true;
  const tz = schedule.timezone || fallbackTz || "UTC";
  const { dow, minutes } = wallClock(nowMs, tz);
  return schedule.windows.some((w) => {
    const days = Array.isArray(w.days) ? w.days : null;
    if (days && !days.includes(dow)) return false;
    const start = toMinutes(w.start ?? "00:00");
    const end = toMinutes(w.end ?? "24:00");
    if (end <= start) return minutes >= start || minutes < end;
    return minutes >= start && minutes < end;
  });
}

// src/lib/distribution/regexSafety.js
var MAX_PATTERN_LENGTH = 200;
var MAX_QUANTIFIERS = 12;
function stripEscapes(src) {
  return src.replace(/\\./g, "__");
}
function splitTopLevelAlternatives(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
function hasAmbiguousAlternatives(alts) {
  if (alts.length < 2) return false;
  for (let i = 0; i < alts.length; i++) {
    if (!alts[i]) continue;
    for (let j = 0; j < alts.length; j++) {
      if (i === j) continue;
      if (alts[j].startsWith(alts[i])) return true;
    }
  }
  return false;
}
function isSafeRegexPattern(pattern) {
  const src = String(pattern ?? "");
  if (!src) return { safe: true };
  if (src.length > MAX_PATTERN_LENGTH) return { safe: false, reason: "pattern too long" };
  const clean = stripEscapes(src);
  const quantCount = (clean.match(/[+*]|\{\d+,?\d*\}/g) || []).length;
  if (quantCount > MAX_QUANTIFIERS) return { safe: false, reason: "too many quantifiers" };
  const stack = [];
  let ambiguousAltGroups = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "(") {
      stack.push({ start: i + 1 });
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g) continue;
      const body = clean.slice(g.start, i);
      const rest = clean.slice(i + 1);
      const quantified = rest[0] === "+" || rest[0] === "*" || rest[0] === "?" || /^\{\d+,?\d*\}/.test(rest);
      const alts = splitTopLevelAlternatives(body);
      if (quantified) {
        const bodyHasQuantifier = /[+*]|\{\d+,?\d*\}/.test(body);
        if (bodyHasQuantifier || alts.length > 1) {
          return { safe: false, reason: "nested quantifier or quantified alternation" };
        }
      }
      if (alts.length > 1 && hasAmbiguousAlternatives(alts)) {
        ambiguousAltGroups += 1;
        if (ambiguousAltGroups >= 2) {
          return { safe: false, reason: "multiple ambiguous alternation groups" };
        }
      }
    }
  }
  return { safe: true };
}
function safeTest(pattern, text) {
  if (!pattern) return false;
  if (!isSafeRegexPattern(pattern).safe) return false;
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

// src/lib/distribution/deliveryAttempt.js
var ATTEMPT_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
  QUEUED: "queued",
  ERROR: "error",
  DEAD_LETTER: "dead_letter",
  // A destination genuinely accepted this attempt, but a DIFFERENT
  // destination had already won the same lead by the time this one
  // completed (a cross-destination retry race). No business effect (no cap
  // finalize, no wallet debit) is applied for a superseded attempt; see
  // reserveAndDeliver's lead-level winner claim in distributeRun.js.
  SUPERSEDED: "superseded"
};
var TERMINAL = /* @__PURE__ */ new Set([
  ATTEMPT_STATUS.ACCEPTED,
  ATTEMPT_STATUS.REJECTED,
  ATTEMPT_STATUS.DUPLICATE,
  ATTEMPT_STATUS.DEAD_LETTER,
  ATTEMPT_STATUS.SUPERSEDED
]);
function computeBackoffMs(attemptNumber, opts = {}) {
  const base = opts.baseMs ?? 1e3;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 60 * 60 * 1e3;
  const n = Math.max(1, attemptNumber);
  return Math.min(max, base * Math.pow(factor, n - 1));
}
function nextRetryAtIso(nowMs, attemptNumber, opts = {}) {
  return new Date(nowMs + computeBackoffMs(attemptNumber, opts)).toISOString();
}
function shouldRetry(status, attemptNumber, maxAttempts = 5) {
  if (TERMINAL.has(status)) return false;
  if (status === ATTEMPT_STATUS.ACCEPTED) return false;
  const retryable = status === ATTEMPT_STATUS.ERROR || status === ATTEMPT_STATUS.QUEUED;
  return retryable && attemptNumber < maxAttempts;
}
var MAX_CLASSIFY_TEXT_LENGTH = 1e4;
function classifyResponse({ httpStatus, body, error, mapping = {} } = {}) {
  if (error) return ATTEMPT_STATUS.ERROR;
  const fullText = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const text = fullText.length > MAX_CLASSIFY_TEXT_LENGTH ? fullText.slice(0, MAX_CLASSIFY_TEXT_LENGTH) : fullText;
  const test = (re) => safeTest(re, text);
  if (mapping.duplicate && test(mapping.duplicate)) return ATTEMPT_STATUS.DUPLICATE;
  if (mapping.reject && test(mapping.reject)) return ATTEMPT_STATUS.REJECTED;
  if (mapping.queue && test(mapping.queue)) return ATTEMPT_STATUS.QUEUED;
  if (mapping.accept && test(mapping.accept)) return ATTEMPT_STATUS.ACCEPTED;
  if (httpStatus == null) return ATTEMPT_STATUS.ERROR;
  if (httpStatus >= 200 && httpStatus < 300) {
    if (mapping.requireAccept && mapping.accept) return ATTEMPT_STATUS.REJECTED;
    return ATTEMPT_STATUS.ACCEPTED;
  }
  if (httpStatus === 409) return ATTEMPT_STATUS.DUPLICATE;
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return ATTEMPT_STATUS.ERROR;
  if (httpStatus >= 400) return ATTEMPT_STATUS.REJECTED;
  return ATTEMPT_STATUS.ERROR;
}
function toClassifyResponseMapping(rm) {
  if (!rm || typeof rm !== "object") return {};
  return {
    accept: rm.accepted || null,
    reject: rm.rejected || null,
    duplicate: rm.duplicate || null,
    queue: rm.queued || null,
    requireAccept: rm.require_accept === true,
    revenuePath: rm.revenue || null,
    leadIdPath: rm.buyer_lead_id || null
  };
}
function buildAttemptRecord({
  leadId,
  destinationId,
  trigger,
  attemptNumber = 1,
  idempotencyKey: idempotencyKey2,
  isPrimary = false,
  status,
  request = {},
  response = {},
  httpStatus = null,
  latencyMs = null,
  errorClass = null,
  nowMs = 0,
  retryOpts = {}
}) {
  const willRetry = shouldRetry(status, attemptNumber, retryOpts.maxAttempts ?? 5);
  const finalStatus = !willRetry && (status === ATTEMPT_STATUS.ERROR || status === ATTEMPT_STATUS.QUEUED) && attemptNumber >= (retryOpts.maxAttempts ?? 5) ? ATTEMPT_STATUS.DEAD_LETTER : status;
  return {
    lead_id: leadId,
    destination_id: destinationId,
    trigger: trigger ?? null,
    attempt_number: attemptNumber,
    idempotency_key: idempotencyKey2 ?? null,
    is_primary: !!isPrimary,
    status: finalStatus,
    request_meta: JSON.stringify(redact(minimizeRequest(request))),
    response_meta: JSON.stringify(minimizeResponse(response)),
    http_status: httpStatus,
    latency_ms: latencyMs,
    error_class: errorClass,
    next_retry_at: willRetry ? nextRetryAtIso(nowMs, attemptNumber, retryOpts) : null,
    completed_at: new Date(nowMs).toISOString()
  };
}
function minimizeRequest(req) {
  return { method: req.method, url: req.url, headers: req.headers, body_present: req.body != null };
}
function minimizeResponse(res) {
  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {});
  return { status: res.status ?? null, body_excerpt: text.slice(0, 500) };
}

// src/lib/distribution/deliveryResolve.js
function parseJson(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function toFieldMap(fm) {
  if (Array.isArray(fm)) return fm;
  if (fm && typeof fm === "object") return Object.entries(fm).map(([dest, src]) => ({ src, dest }));
  return [];
}
var HEADER_SECRET_KEYS = ["authorization", "api_key", "apikey", "x-api-key", "password", "secret", "token", "bearer"];
function projectSubDeliveryForClient(sd) {
  if (!sd) return null;
  const rawHeaders = parseJson(sd.headers) || {};
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    headers[k] = HEADER_SECRET_KEYS.some((s) => k.toLowerCase().includes(s)) ? "[redacted]" : v;
  }
  return {
    id: sd.id,
    delivery_id: sd.delivery_id,
    name: sd.name || "",
    active: sd.active !== false,
    order_index: Number(sd.order_index) || 0,
    target_url: sd.target_url || "",
    method: sd.method || "POST",
    encoding: sd.encoding || "json",
    query_params: sd.query_params || "",
    delete_with_body: sd.delete_with_body === true,
    headers,
    field_map: sd.field_map || "",
    transforms: sd.transforms || "",
    response_mapping: sd.response_mapping || "",
    timeout_ms: Number(sd.timeout_ms) || 1e4,
    retry_policy: sd.retry_policy || "",
    // Credential: presence + last-updated only. Never the value, never the ref.
    credential_present: !!sd.credential_ref,
    credential_updated_at: sd.credential_updated_at || null
  };
}
var MAX_SEND_TIMEOUT_MS = 2e4;
function resolveSubDeliveryCfg(sd) {
  if (!sd) return null;
  const retry = parseJson(sd.retry_policy) || {};
  return {
    subDeliveryId: sd.id,
    targetUrl: sd.target_url || "",
    method: sd.method || "POST",
    encoding: sd.encoding === "form" ? "form" : "json",
    headers: parseJson(sd.headers) || {},
    // NON-secret headers only (schema forbids secrets here)
    credentialRef: sd.credential_ref || null,
    // opaque reference; resolved at send time
    fieldMap: toFieldMap(parseJson(sd.field_map)),
    // Authoritative over fieldMap when non-empty; see directPost.js.
    payloadTemplate: typeof sd.payload_template === "string" ? sd.payload_template : "",
    // Additive: resolved the same way as payloadTemplate, but appended as URL
    // query parameters rather than a request body. See directPost.js.
    queryParamsTemplate: typeof sd.query_params === "string" ? sd.query_params : "",
    deleteWithBody: sd.delete_with_body === true,
    transforms: parseJson(sd.transforms) || [],
    responseMapping: toClassifyResponseMapping(parseJson(sd.response_mapping)),
    timeoutMs: Math.min(Number(sd.timeout_ms) || 1e4, MAX_SEND_TIMEOUT_MS),
    retryOpts: retry
  };
}

// src/lib/distribution/destinationHealth.js
var CIRCUIT = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };
function nextHealth(cur, success, nowMs, opts = {}) {
  const threshold = opts.failureThreshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 6e4;
  const h = cur || { state: CIRCUIT.CLOSED, consecutive_failures: 0 };
  if (success) {
    return { state: CIRCUIT.CLOSED, consecutive_failures: 0, last_success_at: new Date(nowMs).toISOString(), disabled_until: null };
  }
  const failures = (h.consecutive_failures || 0) + 1;
  const open = failures >= threshold;
  return {
    state: open ? CIRCUIT.OPEN : h.state === CIRCUIT.HALF_OPEN ? CIRCUIT.OPEN : CIRCUIT.CLOSED,
    consecutive_failures: failures,
    last_failure_at: new Date(nowMs).toISOString(),
    disabled_until: open ? new Date(nowMs + cooldownMs).toISOString() : h.disabled_until || null
  };
}
function isBlocked(h, nowMs) {
  if (!h || h.state === CIRCUIT.CLOSED) return false;
  if (h.state === CIRCUIT.OPEN) {
    if (h.disabled_until && Date.parse(h.disabled_until) > nowMs) return true;
    return false;
  }
  return false;
}
function normalizeKey(key) {
  if (key && typeof key === "object") {
    return { subDeliveryId: key.subDeliveryId || null, destinationId: key.destinationId || null };
  }
  return { subDeliveryId: null, destinationId: key || null };
}
function makeInMemoryHealthStore() {
  const map = /* @__PURE__ */ new Map();
  const mapKey = ({ subDeliveryId, destinationId }) => `sd:${subDeliveryId || ""}|d:${destinationId || ""}`;
  return {
    async get(key) {
      return map.get(mapKey(normalizeKey(key))) || null;
    },
    async set(key, h) {
      map.set(mapKey(normalizeKey(key)), h);
      return h;
    },
    async recordResult(key, success, nowMs, opts) {
      const k = mapKey(normalizeKey(key));
      const next = nextHealth(map.get(k), success, nowMs, opts);
      map.set(k, next);
      return next;
    },
    _debug: { map }
  };
}
function makeEntityHealthStore(db) {
  async function get(rawKey) {
    const { subDeliveryId, destinationId } = normalizeKey(rawKey);
    if (subDeliveryId) {
      const rows = await db.entities.DestinationHealth.filter({ sub_delivery_id: subDeliveryId });
      if (rows[0]) return rows[0];
    }
    if (destinationId) {
      const rows = await db.entities.DestinationHealth.filter({ destination_id: destinationId });
      if (rows[0]) return rows[0];
    }
    return null;
  }
  return {
    get,
    async set(rawKey, h) {
      const { subDeliveryId, destinationId } = normalizeKey(rawKey);
      const cur = await get(rawKey);
      const patch = { ...h, sub_delivery_id: subDeliveryId || null, destination_id: destinationId || subDeliveryId || null };
      if (cur) return db.entities.DestinationHealth.update(cur.id, patch);
      return db.entities.DestinationHealth.create(patch);
    },
    async recordResult(rawKey, success, nowMs, opts) {
      const cur = await get(rawKey);
      const next = nextHealth(cur, success, nowMs, opts);
      await this.set(rawKey, next);
      return next;
    }
  };
}

// src/lib/distribution/snapshot.js
var KNOWN_OPS = new Set(OPERATORS);
function strictJson(raw, onError) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    onError();
    return null;
  }
}
function validConditionTree(node) {
  if (!node) return true;
  if (Array.isArray(node)) return node.every(validConditionTree);
  if (node.op === "and" || node.op === "or") return (node.children || []).every(validConditionTree);
  if (node.field && node.operator) return KNOWN_OPS.has(node.operator);
  return false;
}
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function buildCaps(capsCfg, memberId, capCountsFor, onError) {
  if (capsCfg == null || capsCfg === "") return {};
  const parsed = strictJson(capsCfg, onError);
  if (parsed === null) return null;
  const out = {};
  for (const w of ["total", "hourly", "daily", "weekly", "monthly"]) {
    if (parsed[w] == null) continue;
    const limit = num(typeof parsed[w] === "object" ? parsed[w].limit : parsed[w]);
    if (limit == null || limit < 0) {
      onError();
      return null;
    }
    out[w] = { limit, count: Number(capCountsFor(memberId, w) || 0) };
  }
  return out;
}
function buildWallet(buyer) {
  if (!buyer) return null;
  const mode = String(buyer.billing_type || buyer.billing_mode || "").toLowerCase().startsWith("prepay") ? "prepaid" : String(buyer.billing_type || "").toLowerCase().startsWith("invoice") ? "postpaid" : null;
  if (!mode) return null;
  const creditLimit = num(buyer.credit_limit);
  const enforce = creditLimit != null && creditLimit > 0;
  if (mode === "prepaid") {
    return {
      mode,
      enforce,
      creditLimit,
      balance: num(buyer.prepay_balance ?? buyer.balance) ?? 0,
      minBalance: num(buyer.min_balance) ?? 0
    };
  }
  return { mode, enforce, outstanding: num(buyer.outstanding) ?? 0, creditLimit };
}
function buildRoutingSnapshot(records, ctx = {}) {
  const { campaignId, configVersionId, leadState } = ctx;
  const capCountsFor = ctx.capCountsFor || (() => 0);
  const stateCplFor = ctx.stateCplFor || (() => null);
  const buyersById = indexBy(records.buyers, "id");
  const destById = indexBy(records.destinations, "id");
  const subDeliveriesById = indexBy(records.subDeliveries, "id");
  const deliveriesById = indexBy(records.deliveries, "id");
  const healthByDest = indexBy(records.health, "destination_id");
  const healthBySubDelivery = indexBy(records.health, "sub_delivery_id");
  const configErrors = [];
  const groups = (records.groups || []).filter((g) => g.active === true && String(g.lifecycle || "").toLowerCase() === "active" && String(g.campaign_id) === String(campaignId) && (!configVersionId || String(g.config_version_id || "") === String(configVersionId))).sort((a, b) => (a.order_index || 0) - (b.order_index || 0)).map((g) => ({
    id: g.id,
    orderIndex: g.order_index || 0,
    method: g.method || "priority",
    configHash: g.config_hash || null,
    weights: { price: num(g.price_weight) ?? 0.5, priority: num(g.priority_weight) ?? 0.5 },
    members: (records.members || []).filter((m) => String(m.route_group_id) === String(g.id)).sort((a, b) => (a.priority || 0) - (b.priority || 0)).map((m) => buildMember(m, {
      buyersById,
      destById,
      subDeliveriesById,
      deliveriesById,
      healthByDest,
      healthBySubDelivery,
      capCountsFor,
      configErrors,
      nowMs: ctx.nowMs,
      leadState,
      stateCplFor
    }))
  }));
  return { groups, configVersionId: configVersionId || null, configErrors, configHash: hashConfig(records) };
}
function resolveEndpoint(m, { destById, subDeliveriesById, deliveriesById, err }) {
  if (m.sub_delivery_id) {
    const sd = subDeliveriesById[m.sub_delivery_id];
    if (!sd) {
      err("CONFIG_INVALID", "missing sub-delivery");
      return null;
    }
    if (sd.active === false) {
      err("CONFIG_INVALID", "inactive sub-delivery");
      return null;
    }
    const del = deliveriesById[sd.delivery_id];
    if (!del) {
      err("CONFIG_INVALID", "missing parent delivery");
      return null;
    }
    if (String(del.status) !== "active") {
      err("CONFIG_INVALID", "parent delivery not active");
      return null;
    }
    if (String(del.buyer_id) !== String(m.buyer_id)) {
      err("CONFIG_INVALID", "cross-buyer sub-delivery");
      return null;
    }
    if (!sd.target_url) {
      err("CONFIG_INVALID", "sub-delivery missing target_url");
      return null;
    }
    return { subDeliveryId: sd.id, delivery: resolveSubDeliveryCfg(sd), healthKey: sd.id, kind: "sub_delivery" };
  }
  if (m.destination_id && destById[m.destination_id]) {
    return { subDeliveryId: null, delivery: null, healthKey: m.destination_id, kind: "legacy" };
  }
  err("CONFIG_INVALID", m.destination_id ? "missing destination" : "missing sub_delivery_id");
  return null;
}
function buildMember(m, { buyersById, destById, subDeliveriesById, deliveriesById, healthByDest, healthBySubDelivery, capCountsFor, configErrors, nowMs, leadState, stateCplFor }) {
  let invalid = false;
  const err = (code, detail) => {
    invalid = true;
    configErrors.push({ member_id: m.id, code: code || "CONFIG_INVALID", detail });
  };
  const buyer = buyersById[m.buyer_id];
  if (!buyer) err("CONFIG_INVALID", "missing buyer");
  const endpoint = resolveEndpoint(m, { destById, subDeliveriesById, deliveriesById, err });
  const filters = strictJson(m.filters, () => err("CONFIG_INVALID", "bad filters json"));
  const conditions = strictJson(m.conditions, () => err("CONFIG_INVALID", "bad conditions json"));
  const hasConditions = conditions && typeof conditions === "object" && Object.keys(conditions).length > 0;
  if (hasConditions && !validConditionTree(conditions)) err("CONFIG_INVALID", "unknown condition operator");
  const schedule = strictJson(m.schedule, () => err("CONFIG_INVALID", "bad schedule json"));
  const caps = buildCaps(m.caps, m.id, capCountsFor, () => err("CONFIG_INVALID", "bad caps"));
  const priceMode = ["fixed", "rule", "auction"].includes(m.price_mode) ? m.price_mode : "fixed";
  const reservePrice = num(m.reserve_price);
  let fixedPrice = num(m.fixed_price);
  if (priceMode === "fixed" && (fixedPrice == null || fixedPrice < 0)) err("CONFIG_INVALID", "invalid price");
  if (priceMode === "rule" && leadState !== void 0) {
    const rulePrice = num(stateCplFor(m.buyer_id, leadState));
    if (rulePrice == null || rulePrice < 0) err("CONFIG_INVALID", "no active BuyerStateCpl price for this buyer/state");
    fixedPrice = rulePrice;
  }
  const buyerSnap = buyer ? { active: buyer.active, status: buyer.status } : { active: false, status: "missing" };
  const healthKey = endpoint ? endpoint.healthKey : m.destination_id;
  const healthRecord = healthBySubDelivery[healthKey] || healthByDest[healthKey] || null;
  return {
    id: m.id,
    buyerId: m.buyer_id,
    destinationId: m.destination_id,
    subDeliveryId: endpoint ? endpoint.subDeliveryId : null,
    // Canonical outbound cfg resolved from the SubDelivery (null for legacy members).
    delivery: endpoint ? endpoint.delivery : null,
    // PB-017: invalid config makes the member ineligible, never unrestricted.
    active: m.active !== false && !invalid,
    _configInvalid: invalid,
    priority: num(m.priority) ?? 1,
    weight: num(m.weight) ?? 1,
    reservePrice,
    priceMode,
    fixedPrice: fixedPrice ?? 0,
    price: fixedPrice ?? 0,
    filters: invalid ? {} : filters || {},
    conditions: invalid ? null : hasConditions ? conditions : null,
    schedule: schedule || null,
    // Pre-resolve the schedule to the boolean the engine reads. Absent schedule
    // means always-on. nowMs must be supplied for correct dayparting.
    withinSchedule: schedule && Object.keys(schedule).length ? isWithinSchedule(nowMs ?? 0, schedule) : void 0,
    caps: caps || {},
    buyer: buyerSnap,
    wallet: buildWallet(buyer),
    // Pre-resolved the same way withinSchedule is: engine.js stays pure of
    // ambient time, reading only the boolean. `state` is retained for
    // logging/debugging, not for the eligibility decision itself.
    health: { state: healthRecord?.state || "closed", blocked: isBlocked(healthRecord, nowMs ?? 0) }
  };
}
function indexBy(arr, key) {
  const out = {};
  for (const r of arr || []) out[String(r[key])] = r;
  return out;
}
function buildMemberForRetry(rm, buyer, deliveryCfg) {
  if (!rm) return null;
  const priceMode = ["fixed", "rule", "auction"].includes(rm.price_mode) ? rm.price_mode : "fixed";
  if (priceMode === "rule") return null;
  let capsInvalid = false;
  const caps = buildCaps(rm.caps, rm.id, () => 0, () => {
    capsInvalid = true;
  });
  if (capsInvalid) return null;
  const fixedPrice = num(rm.fixed_price);
  if (priceMode === "fixed" && (fixedPrice == null || fixedPrice < 0)) return null;
  return {
    id: rm.id,
    buyerId: rm.buyer_id,
    destinationId: rm.destination_id || null,
    subDeliveryId: deliveryCfg ? deliveryCfg.subDeliveryId : null,
    delivery: deliveryCfg,
    priceMode,
    fixedPrice: fixedPrice ?? 0,
    price: fixedPrice ?? 0,
    caps: caps || {},
    wallet: buildWallet(buyer)
  };
}
function hashConfig(records) {
  const material = JSON.stringify({
    g: (records.groups || []).map((g) => [g.id, g.method, g.order_index, g.lifecycle, g.active]),
    m: (records.members || []).map((m) => [m.id, m.route_group_id, m.buyer_id, m.destination_id, m.priority, m.filters, m.caps])
  });
  let h = 2166136261;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// src/lib/distribution/snapshotLoader.js
var PAGE = 200;
var CAP_WINDOWS2 = ["total", "hourly", "daily", "weekly", "monthly"];
function parseCapsJson(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
var activeGroupCache = /* @__PURE__ */ new Map();
async function loadAllFiltered(entity, query, { sort = "created_date", maxPages = 25 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await entity.filter(query, sort, PAGE, page * PAGE);
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
async function hasActiveRouteGroup(db, campaignId, nowMs, ttlMs = 5e3) {
  const cached = activeGroupCache.get(campaignId);
  if (cached && cached.expires > nowMs) return cached.has;
  const rows = await db.entities.RouteGroup.filter({ campaign_id: campaignId, active: true, lifecycle: "active" }, "order_index", 1, 0);
  const has = !!(rows && rows.length);
  activeGroupCache.set(campaignId, { has, expires: nowMs + ttlMs });
  return has;
}
function _clearActiveGroupCache() {
  activeGroupCache.clear();
}
async function loadRoutingSnapshot(db, { campaignId, nowMs, configVersionId, leadState }) {
  const groups = await loadAllFiltered(db.entities.RouteGroup, { campaign_id: campaignId, active: true, lifecycle: "active" }, { sort: "order_index" });
  const groupIds = groups.map((g) => g.id);
  let members = [];
  for (const gid of groupIds) {
    members = members.concat(await loadAllFiltered(db.entities.RouteMember, { route_group_id: gid }, { sort: "priority" }));
  }
  const buyerIds = [...new Set(members.map((m) => m.buyer_id).filter(Boolean))];
  const destIds = [...new Set(members.map((m) => m.destination_id).filter(Boolean))];
  const subDeliveryIds = [...new Set(members.map((m) => m.sub_delivery_id).filter(Boolean))];
  const buyers = [];
  for (const id of buyerIds) {
    const r = await db.entities.Buyer.filter({ id });
    if (r && r[0]) buyers.push(r[0]);
  }
  const destinations = [];
  for (const id of destIds) {
    const r = await db.entities.LeadByteConnector.filter({ id });
    if (r && r[0]) destinations.push(r[0]);
  }
  const subDeliveries = [];
  if (db.entities.SubDelivery) {
    for (const id of subDeliveryIds) {
      const r = await db.entities.SubDelivery.filter({ id });
      if (r && r[0]) subDeliveries.push(r[0]);
    }
  }
  const deliveryIds = [...new Set(subDeliveries.map((sd) => sd.delivery_id).filter(Boolean))];
  const deliveries = [];
  if (db.entities.Delivery) {
    for (const id of deliveryIds) {
      const r = await db.entities.Delivery.filter({ id });
      if (r && r[0]) deliveries.push(r[0]);
    }
  }
  const health = [];
  for (const id of subDeliveryIds) {
    const r = await db.entities.DestinationHealth.filter({ sub_delivery_id: id });
    if (r && r[0]) health.push(r[0]);
  }
  for (const id of destIds) {
    const r = await db.entities.DestinationHealth.filter({ destination_id: id });
    if (r && r[0]) health.push(r[0]);
  }
  const capMap = {};
  if (db.entities.CapCounter) {
    for (const m of members) {
      const parsedCaps = parseCapsJson(m.caps);
      for (const w of CAP_WINDOWS2) {
        if (parsedCaps[w] == null) continue;
        const bucket = w === "total" ? "all" : capWindowStart(nowMs, w);
        const key = capScopeKey(m.id, w, bucket);
        try {
          const rows = await db.entities.CapCounter.filter({ scope_key: key });
          if (rows && rows[0]) capMap[`${m.id}:${w}`] = Number(rows[0].count || 0);
        } catch {
        }
      }
    }
  }
  const capCountsFor = (memberId, window) => capMap[`${memberId}:${window}`] || 0;
  let vertical = null;
  if (campaignId && db.entities.Campaign) {
    try {
      const rows = await db.entities.Campaign.filter({ id: campaignId });
      vertical = rows && rows[0] && rows[0].vertical || null;
    } catch {
    }
  }
  const stateCplMap = {};
  if (db.entities.BuyerStateCpl && vertical) {
    for (const buyerId of buyerIds) {
      try {
        const rows = await db.entities.BuyerStateCpl.filter({ buyer_id: buyerId, vertical, active: true });
        for (const r of rows || []) stateCplMap[`${buyerId}:${String(r.state || "").toUpperCase()}`] = Number(r.cpl);
      } catch {
      }
    }
  }
  const stateCplFor = (buyerId, state) => {
    const v = stateCplMap[`${buyerId}:${String(state || "").toUpperCase()}`];
    return v == null ? null : v;
  };
  return buildRoutingSnapshot(
    { groups, members, buyers, destinations, subDeliveries, deliveries, health },
    { campaignId, nowMs, configVersionId, capCountsFor, leadState, stateCplFor }
  );
}

// src/lib/distribution/shadowHook.js
async function runShadow(db, ctx) {
  const { distributionMode, leadData, campaignId, idempotencyKey: idempotencyKey2 } = ctx;
  const clock = ctx.clock || (() => Date.now());
  const nowMs = ctx.nowMs ?? clock();
  if (distributionMode === "legacy_only" || !distributionMode) return { ran: false, reason: "legacy_only" };
  try {
    const hasGroups = await hasActiveRouteGroup(db, campaignId, nowMs);
    if (!hasGroups) {
      await db.entities.RouteDecisionTrace.create({
        lead_id: ctx.leadId,
        distribution_mode: distributionMode,
        result: "no_route_config",
        winner_member_id: "",
        evaluated_candidates: "[]",
        fallthrough_path: "[]",
        config_version: null,
        eval_latency_ms: 0,
        created_at: new Date(nowMs).toISOString()
      });
      return { ran: false, reason: "no_route_config" };
    }
    const t0 = clock();
    const snap = await loadRoutingSnapshot(db, { campaignId, nowMs });
    const decision = routeWaterfall(snap.groups, leadData || {}, {
      idempotencyKey: idempotencyKey2,
      evalConditions: (t, d) => evalConditionTree(t, d, { nowMs })
    });
    const latency = clock() - t0;
    await db.entities.RouteDecisionTrace.create({
      lead_id: ctx.leadId,
      idempotency_key: idempotencyKey2 || null,
      distribution_mode: distributionMode,
      evaluated_candidates: JSON.stringify(flattenTrace(decision.trace)),
      winner_member_id: decision.winner ? decision.winner.id : "",
      winning_group_id: decision.groupId || "",
      price: decision.winner ? decision.price : 0,
      fallthrough_path: JSON.stringify(decision.fallthroughPath || []),
      result: decision.winner ? "shadow_selected" : decision.reason || "no_eligible_member",
      config_version: decision.winner && decision.configHash || snap.configHash || null,
      eval_latency_ms: latency,
      created_at: new Date(nowMs).toISOString()
    });
    return { ran: true, latencyMs: latency, winner: decision.winner ? decision.winner.id : null };
  } catch (err) {
    try {
      await db.entities.RouteDecisionTrace.create({
        lead_id: ctx.leadId,
        distribution_mode: distributionMode,
        result: "evaluation_error",
        winner_member_id: "",
        evaluated_candidates: "[]",
        fallthrough_path: "[]",
        error_message: String(err && err.message ? err.message : err).slice(0, 300),
        created_at: new Date(nowMs).toISOString()
      });
    } catch {
    }
    return { ran: false, reason: "evaluation_error", error: String(err && err.message ? err.message : err) };
  }
}
function flattenTrace(trace) {
  const out = [];
  for (const g of trace || []) for (const c of g.candidates || []) {
    out.push({ group_id: g.groupId, member_id: c.memberId, eligible: c.eligible, reason_code: c.reason, price: c.price });
  }
  return out;
}

// src/lib/distribution/simulateReport.js
var REASON_TEXT = {
  ELIGIBLE: "Eligible",
  MEMBER_INACTIVE: "Route member inactive",
  BUYER_LIFECYCLE_INELIGIBLE: "Buyer not active",
  OUTSIDE_SCHEDULE: "Outside schedule",
  FILTER_STATE: "State not covered",
  FILTER_ZIP: "ZIP not covered",
  FILTER_COUNTY: "County not covered",
  FILTER_VERTICAL: "Vertical not accepted",
  FILTER_BRAND: "Brand not accepted",
  FILTER_SUPPLIER: "Supplier not accepted",
  FILTER_SOURCE: "Source not accepted",
  QUALIFICATION_FAILED: "Failed qualification",
  SUPPRESSED: "Suppressed",
  CAP_TOTAL: "Total cap reached",
  CAP_HOURLY: "Hourly cap reached",
  CAP_DAILY: "Daily cap reached",
  CAP_WEEKLY: "Weekly cap reached",
  CAP_MONTHLY: "Monthly cap reached",
  LOW_BALANCE: "Wallet balance too low",
  OVER_CREDIT_LIMIT: "Over credit limit",
  DESTINATION_UNHEALTHY: "Destination circuit open",
  BELOW_RESERVE: "Below reserve",
  NO_ELIGIBLE_MEMBER: "No eligible route member"
};
async function runSimulation(db, { campaignId, leadData, nowMs }) {
  const snap = await loadRoutingSnapshot(db, { campaignId, nowMs });
  const decision = routeWaterfall(snap.groups, leadData || {}, {
    idempotencyKey: "simulate",
    evalConditions: (t, d) => evalConditionTree(t, d, { nowMs })
  });
  const explanation = (decision.trace || []).map((g) => ({
    groupId: g.groupId,
    method: g.method,
    candidates: (g.candidates || []).map((c) => ({
      memberId: c.memberId,
      eligible: c.eligible,
      reason: c.reason,
      reasonText: REASON_TEXT[c.reason] || c.reason,
      price: c.price
    }))
  }));
  return {
    simulated: true,
    sideEffects: "none",
    configVersion: snap.configHash,
    configErrors: snap.configErrors,
    decision: decision.winner ? {
      winnerMemberId: decision.winner.id,
      buyerId: decision.winner.buyerId ?? null,
      groupId: decision.groupId,
      method: decision.method,
      price: decision.price,
      fallthroughPath: decision.fallthroughPath
    } : { winnerMemberId: null, reason: decision.reason || "NO_ELIGIBLE_MEMBER" },
    explanation
  };
}

// src/lib/distribution/capStore.js
function makeInMemoryCasStore({ yieldFn } = {}) {
  const counters = /* @__PURE__ */ new Map();
  const claims = /* @__PURE__ */ new Map();
  const reservations = [];
  let seq = 0;
  const microYield = yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
  async function incrementIfBelow(key, limit, meta = null, maxRetry = 100) {
    void meta;
    for (let i = 0; i < maxRetry; i++) {
      const cur = counters.get(key) || { value: 0, version: 0 };
      const { value, version } = cur;
      await microYield();
      if (value >= limit) return false;
      const latest = counters.get(key) || { value: 0, version: 0 };
      if (latest.version !== version) continue;
      counters.set(key, { value: value + 1, version: version + 1 });
      return true;
    }
    return false;
  }
  async function decrement(key) {
    for (let i = 0; i < 100; i++) {
      const cur = counters.get(key) || { value: 0, version: 0 };
      const { value, version } = cur;
      await microYield();
      const latest = counters.get(key) || { value: 0, version: 0 };
      if (latest.version !== version) continue;
      counters.set(key, { value: Math.max(0, value - 1), version: version + 1 });
      return;
    }
  }
  async function getCount(key) {
    return (counters.get(key) || { value: 0 }).value;
  }
  async function claim(key) {
    const cur = claims.get(key);
    await microYield();
    if (claims.get(key)) return false;
    if (cur) return false;
    claims.set(key, true);
    return true;
  }
  async function isClaimed(key) {
    return !!claims.get(key);
  }
  async function putReservation(rec) {
    const row = { ...rec, id: "r" + ++seq };
    reservations.push(row);
    return row;
  }
  async function getReservation(idempotencyKey2, memberId) {
    return reservations.find((r) => r.idempotency_key === idempotencyKey2 && r.route_member_id === memberId) || null;
  }
  async function awaitReservation(idempotencyKey2, memberId, tries = 1e3) {
    for (let i = 0; i < tries; i++) {
      const r = await getReservation(idempotencyKey2, memberId);
      if (r) return r;
      await microYield();
    }
    return null;
  }
  async function updateReservation(id, patch) {
    const r = reservations.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
  return {
    incrementIfBelow,
    decrement,
    getCount,
    claim,
    isClaimed,
    putReservation,
    getReservation,
    awaitReservation,
    updateReservation,
    _debug: { counters, reservations }
  };
}
function makeEntityCapStore(db) {
  async function ensureCounter(key, meta) {
    let rows = await db.entities.CapCounter.filter({ scope_key: key });
    if (!rows.length) {
      try {
        await db.entities.CapCounter.create({ scope_key: key, count: 0, ...meta || {} });
      } catch (err) {
        rows = await db.entities.CapCounter.filter({ scope_key: key });
        if (!rows.length) throw err;
      }
      if (!rows.length) rows = await db.entities.CapCounter.filter({ scope_key: key });
    }
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return rows[0];
  }
  async function incrementIfBelow(key, limit, meta = null, maxRetry = 25) {
    for (let i = 0; i < maxRetry; i++) {
      const row = await ensureCounter(key, meta);
      const value = Number(row.count || 0);
      if (value >= limit) return false;
      const res = await db.entities.CapCounter.updateMany(
        { id: row.id, count: value },
        { $set: { count: value + 1 } }
      );
      if (res && res.updated > 0) return true;
    }
    return false;
  }
  async function decrement(key) {
    for (let i = 0; i < 25; i++) {
      const row = await ensureCounter(key);
      const value = Number(row.count || 0);
      const next = Math.max(0, value - 1);
      const res = await db.entities.CapCounter.updateMany(
        { id: row.id, count: value },
        { $set: { count: next } }
      );
      if (res && res.updated > 0) return;
    }
  }
  async function getCount(key) {
    const row = await ensureCounter(key);
    return Number(row.count || 0);
  }
  async function claim(key) {
    return incrementIfBelow(`claim:${key}`, 1);
  }
  async function isClaimed(key) {
    const rows = await db.entities.CapCounter.filter({ scope_key: `claim:${key}` });
    return !!(rows && rows[0] && Number(rows[0].count || 0) >= 1);
  }
  async function getReservation(idempotencyKey2, memberId) {
    const rows = await db.entities.CapReservation.filter({ idempotency_key: idempotencyKey2, route_member_id: memberId });
    return rows[0] || null;
  }
  async function awaitReservation(idempotencyKey2, memberId, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const r = await getReservation(idempotencyKey2, memberId);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    return null;
  }
  async function putReservation(rec) {
    return db.entities.CapReservation.create(rec);
  }
  async function updateReservation(id, patch) {
    return db.entities.CapReservation.update(id, patch);
  }
  return { incrementIfBelow, decrement, getCount, claim, isClaimed, getReservation, awaitReservation, putReservation, updateReservation };
}

// src/lib/distribution/reservation.js
var RESERVE = {
  OK: "OK",
  ALREADY_RESERVED: "ALREADY_RESERVED",
  // idempotent replay / concurrent duplicate
  CAP_EXCEEDED: "CAP_EXCEEDED"
};
function claimKeyFor(idempotencyKey2, memberId) {
  return `resv:${idempotencyKey2}:${memberId}`;
}
async function reserve(store, { idempotencyKey: idempotencyKey2, leadId, memberId, price = 0, scopes = [] }) {
  const won = await store.claim(claimKeyFor(idempotencyKey2, memberId));
  if (!won) {
    const existing = await store.awaitReservation(idempotencyKey2, memberId);
    if (existing && existing.state === "failed") {
      return { ok: false, code: RESERVE.CAP_EXCEEDED, reservation: existing };
    }
    return { ok: true, code: RESERVE.ALREADY_RESERVED, reservation: existing };
  }
  const incremented = [];
  for (const scope of scopes) {
    if (scope.limit == null) continue;
    const meta = scope.scopeType ? {
      scope_type: scope.scopeType,
      scope_id: scope.memberId ?? null,
      window: scope.window ?? null,
      window_start: scope.windowStart ?? null,
      limit: Number(scope.limit)
    } : null;
    const ok = await store.incrementIfBelow(scope.key, Number(scope.limit), meta);
    if (!ok) {
      for (const s of incremented) await store.decrement(s.key);
      const failed = await store.putReservation({
        idempotency_key: idempotencyKey2,
        lead_id: leadId,
        route_member_id: memberId,
        price: Number(price),
        scopes: [],
        state: "failed"
      });
      return { ok: false, code: RESERVE.CAP_EXCEEDED, scope: scope.key, reservation: failed };
    }
    incremented.push(scope);
  }
  const rec = await store.putReservation({
    idempotency_key: idempotencyKey2,
    lead_id: leadId,
    route_member_id: memberId,
    price: Number(price),
    scopes: incremented.map((s) => s.key),
    state: "reserved"
  });
  return { ok: true, code: RESERVE.OK, reservation: rec };
}
async function finalize(store, reservation) {
  if (!reservation || reservation.state === "finalized") return reservation;
  if (reservation.state !== "reserved") return reservation;
  await store.updateReservation(reservation.id, { state: "finalized" });
  return { ...reservation, state: "finalized" };
}
async function release(store, reservation) {
  if (!reservation || reservation.state !== "reserved") return reservation;
  for (const key of reservation.scopes || []) await store.decrement(key);
  await store.updateReservation(reservation.id, { state: "released" });
  return { ...reservation, state: "released" };
}

// src/lib/distribution/walletStore.js
function makeInMemoryWalletStore({ initial = {}, yieldFn } = {}) {
  const balances = /* @__PURE__ */ new Map();
  for (const [b, v] of Object.entries(initial)) balances.set(b, { balance: v, version: 0 });
  const claims = /* @__PURE__ */ new Map();
  const txns = [];
  let seq = 0;
  const microYield = yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
  async function claimTxn(key) {
    const cur = claims.get(key);
    await microYield();
    if (claims.get(key) || cur) return false;
    claims.set(key, true);
    return true;
  }
  async function getBalance(buyerId) {
    return balances.get(buyerId) || { balance: 0, version: 0 };
  }
  async function casAdjustBalance(buyerId, expectedVersion, newBalance) {
    const cur = balances.get(buyerId) || { balance: 0, version: 0 };
    await microYield();
    const latest = balances.get(buyerId) || { balance: 0, version: 0 };
    if (latest.version !== expectedVersion) return false;
    balances.set(buyerId, { balance: newBalance, version: expectedVersion + 1 });
    return true;
  }
  async function appendTxn(txn) {
    const row = { ...txn, id: "t" + ++seq };
    txns.push(row);
    return row;
  }
  async function getTxnByKey(key) {
    return txns.find((t) => t.idempotency_key === key) || null;
  }
  async function awaitTxnByKey(key, tries = 1e3) {
    for (let i = 0; i < tries; i++) {
      const t = await getTxnByKey(key);
      if (t) return t;
      await microYield();
    }
    return null;
  }
  return {
    claimTxn,
    getBalance,
    casAdjustBalance,
    appendTxn,
    getTxnByKey,
    awaitTxnByKey,
    _debug: { balances, txns }
  };
}
function makeEntityWalletStore(db) {
  async function ensureWallet(buyerId) {
    let rows = await db.entities.BuyerWallet.filter({ buyer_id: buyerId });
    if (!rows.length) {
      await db.entities.BuyerWallet.create({ buyer_id: buyerId, balance: 0, version: 0 });
      rows = await db.entities.BuyerWallet.filter({ buyer_id: buyerId });
    }
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return rows[0];
  }
  async function claimTxn(key) {
    for (let i = 0; i < 25; i++) {
      let rows = await db.entities.CapCounter.filter({ scope_key: `walletclaim:${key}` });
      if (!rows.length) {
        await db.entities.CapCounter.create({ scope_key: `walletclaim:${key}`, count: 0 });
        rows = await db.entities.CapCounter.filter({ scope_key: `walletclaim:${key}` });
      }
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const row = rows[0];
      if (Number(row.count || 0) >= 1) return false;
      const res = await db.entities.CapCounter.updateMany({ id: row.id, count: 0 }, { $set: { count: 1 } });
      if (res && res.updated > 0) return true;
    }
    return false;
  }
  async function getBalance(buyerId) {
    const w = await ensureWallet(buyerId);
    return { balance: Number(w.balance || 0), version: Number(w.version || 0), _id: w.id };
  }
  async function casAdjustBalance(buyerId, expectedVersion, newBalance) {
    const w = await ensureWallet(buyerId);
    if (Number(w.version || 0) !== expectedVersion) return false;
    const res = await db.entities.BuyerWallet.updateMany(
      { id: w.id, version: expectedVersion },
      { $set: { balance: newBalance, version: expectedVersion + 1 } }
    );
    return !!(res && res.updated > 0);
  }
  async function appendTxn(txn) {
    return db.entities.WalletTransaction.create(txn);
  }
  async function getTxnByKey(key) {
    const rows = await db.entities.WalletTransaction.filter({ idempotency_key: key });
    return rows[0] || null;
  }
  async function awaitTxnByKey(key, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const t = await getTxnByKey(key);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
  return { claimTxn, getBalance, casAdjustBalance, appendTxn, getTxnByKey, awaitTxnByKey };
}

// src/lib/distribution/walletLedger.js
var WALLET = { LOW_BALANCE: "LOW_BALANCE", OVER_CREDIT_LIMIT: "OVER_CREDIT_LIMIT" };
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
async function walletDebit(store, { buyerId, amount, idempotencyKey: idempotencyKey2, creditLimit = null, type = "debit", description = "" }) {
  const amt = Number(amount);
  const won = await store.claimTxn(idempotencyKey2);
  if (!won) {
    const existing = await store.awaitTxnByKey(idempotencyKey2);
    return { applied: false, duplicate: true, txn: existing, balanceAfter: existing?.balance_after };
  }
  const floor = creditLimit == null ? 0 : -Math.abs(Number(creditLimit));
  for (let i = 0; i < 200; i++) {
    const { balance, version } = await store.getBalance(buyerId);
    const after = round2(balance - amt);
    if (after < floor) {
      const rej = await store.appendTxn({
        buyer_id: buyerId,
        type,
        amount: amt,
        balance_after: balance,
        idempotency_key: idempotencyKey2,
        status: "rejected",
        description
      });
      return { applied: false, insufficient: true, code: creditLimit == null ? WALLET.LOW_BALANCE : WALLET.OVER_CREDIT_LIMIT, balanceAfter: balance, txn: rej };
    }
    const ok = await store.casAdjustBalance(buyerId, version, after);
    if (!ok) continue;
    const txn = await store.appendTxn({
      buyer_id: buyerId,
      type,
      amount: amt,
      balance_after: after,
      idempotency_key: idempotencyKey2,
      status: "applied",
      description
    });
    return { applied: true, txn, balanceAfter: after };
  }
  return { applied: false, error: "cas_exhausted" };
}
async function walletCredit(store, { buyerId, amount, idempotencyKey: idempotencyKey2, type = "credit", description = "" }) {
  const amt = Number(amount);
  const won = await store.claimTxn(idempotencyKey2);
  if (!won) {
    const existing = await store.awaitTxnByKey(idempotencyKey2);
    return { applied: false, duplicate: true, txn: existing, balanceAfter: existing?.balance_after };
  }
  for (let i = 0; i < 200; i++) {
    const { balance, version } = await store.getBalance(buyerId);
    const after = round2(balance + amt);
    const ok = await store.casAdjustBalance(buyerId, version, after);
    if (!ok) continue;
    const txn = await store.appendTxn({
      buyer_id: buyerId,
      type,
      amount: amt,
      balance_after: after,
      idempotency_key: idempotencyKey2,
      status: "applied",
      description
    });
    return { applied: true, txn, balanceAfter: after };
  }
  return { applied: false, error: "cas_exhausted" };
}
async function walletCreditReturn(store, { buyerId, amount, returnId }) {
  return walletCredit(store, { buyerId, amount, idempotencyKey: `return:${returnId}`, type: "adjustment", description: `return ${returnId}` });
}

// src/lib/distribution/billing.js
function computeBillingLines(leads, approvedReturns = [], dims = ["vertical", "state"]) {
  const returned = new Set((approvedReturns || []).map((r) => r.lead_id));
  const groups = /* @__PURE__ */ new Map();
  for (const lead of leads || []) {
    const key = dims.map((d) => String(lead[d] ?? "")).join("|");
    if (!groups.has(key)) {
      const dimVals = {};
      dims.forEach((d) => {
        dimVals[d] = lead[d] ?? null;
      });
      groups.set(key, { ...dimVals, lead_count: 0, returns: 0, gross: 0, unit_prices: [] });
    }
    const g = groups.get(key);
    g.lead_count += 1;
    g.unit_prices.push(Number(lead.price) || 0);
    if (returned.has(lead.id)) g.returns += 1;
    else g.gross = round22(g.gross + (Number(lead.price) || 0));
  }
  return [...groups.values()].map((g) => ({
    ...g,
    billable_leads: g.lead_count - g.returns,
    unit_price: g.unit_prices.length ? round22(g.unit_prices.reduce((a, b) => a + b, 0) / g.unit_prices.length) : 0,
    amount: g.gross
  })).map(({ unit_prices, ...rest }) => rest);
}
function applyReturnAdjustment(processedReturnIds, returnId) {
  if (processedReturnIds.has(returnId)) return { applied: false, duplicate: true };
  processedReturnIds.add(returnId);
  return { applied: true };
}
function round22(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// src/lib/distribution/transforms.js
function applyTransform(value, transform) {
  const s = value == null ? "" : String(value);
  switch (transform) {
    case "lowercase":
      return s.toLowerCase();
    case "uppercase":
      return s.toUpperCase();
    case "trim":
      return s.trim();
    case "digits":
      return s.replace(/\D/g, "");
    case "phone_us": {
      let d = s.replace(/\D/g, "");
      if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
      return d.length === 10 ? "1" + d : d;
    }
    default:
      return value;
  }
}

// src/lib/distribution/payloadTemplate.js
async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function phoneUs(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length === 10) return "1" + digits;
  return digits;
}
function escapeJsonString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
function resolveTokenValue(token, d) {
  switch (token) {
    case "_c_eventtime":
    case "event_time":
      return String(Math.floor(Date.now() / 1e3));
    case "_c_eventurl":
    case "optin_url":
      return d.optin_url || d.optinurl || d.landing_page_url || d.landingpage_url || "";
    case "_device_userAgent":
    case "user_agent":
      return d.user_agent || d.useragent || "";
    case "_tracking__fbc":
    case "fbc":
      return d.fbc || d._tracking__fbc || "";
    case "_tracking__fbp":
    case "fbp":
      return d.fbp || d._tracking__fbp || "";
    case "_geoip_city":
    case "geoip_city":
    case "city":
      return d.geoip_city || d.city || d._geoip_city || "";
    case "_geoip_regionName":
    case "geoip_state":
    case "state":
      return d.geoip_state || d.state || d._geoip_regionName || "";
    case "_geoip_countryName":
    case "geoip_country":
    case "country":
      return d.geoip_country || d.country || d._geoip_countryName || "";
    case "mobile_raw":
    case "mobile":
      return d.mobile || d.phone1 || d.phone || d.phone_number || "";
    case "conv_value":
      return d.conv_value != null ? String(d.conv_value) : "";
    case "ip_address":
      return d.ip_address || d.ipaddress || "";
    case "email":
      return d.email || "";
    case "first_name":
      return d.first_name || d.firstname || "";
    case "last_name":
      return d.last_name || d.lastname || "";
    case "zip":
      return d.zip || d.zipcode || d.zip_code || "";
    case "lead_event":
      return d.lead_event || "";
    case "accident_state":
      return d.accident_state || d.state || "";
    case "trustedform_url":
      return d.trustedform_url || d.trustedform_cert_url || d.trustedform_cert || "";
    case "jornaya_token":
      return d.jornaya_token || d.leadid_token || d.jornayaid || "";
    case "fault":
      return d.fault || d.at_fault || d.atfault || "";
    case "treatment":
      return d.treatment || d.physical_injury || d.injury || "";
    case "attorney":
      return d.attorney || d.with_lawyer || d.has_attorney || d.lawyer || "";
    case "incident_date_2":
      return d.incident_date_2 || d.incident_date || d.accident_date || "";
    case "incident_date_3":
      return d.incident_date_3 || d.incident_date || d.accident_date || "";
    case "accident_details":
      return d.accident_details || d.case_description || d.accident_description || "";
    default: {
      const val = d[token];
      return val !== void 0 && val !== null ? String(val) : "";
    }
  }
}
async function applyTransform2(value, transform) {
  switch (transform) {
    case "sha256":
      return await sha256Hex(value);
    case "lowercase":
      return String(value).toLowerCase();
    case "uppercase":
      return String(value).toUpperCase();
    case "trim":
      return String(value).trim();
    case "phone_us":
      return phoneUs(value);
    default:
      return value;
  }
}
async function resolveTemplate(templateStr, data) {
  const pattern = /\{\{([\w.]+(?:\|[\w]+)*)\}\}/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(templateStr)) !== null) {
    matches.push({ expr: m[1], index: m.index, length: m[0].length });
  }
  const resolved = await Promise.all(matches.map(async (match) => {
    const parts = match.expr.split("|").map((s) => s.trim());
    const token = parts[0];
    const transforms = parts.slice(1);
    let value = resolveTokenValue(token, data || {});
    for (const t of transforms) {
      value = await applyTransform2(value, t);
    }
    return escapeJsonString(value);
  }));
  let result = templateStr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    result = result.slice(0, match.index) + resolved[i] + result.slice(match.index + match.length);
  }
  return result;
}
async function buildPayloadFromTemplate(template, data) {
  if (!template) return data;
  const tmpl = typeof template === "string" ? template : JSON.stringify(template);
  const resolved = await resolveTemplate(tmpl, data);
  try {
    return JSON.parse(resolved);
  } catch {
    return resolved;
  }
}

// src/lib/distribution/directPost.js
function getPath(obj, path) {
  if (!path) return void 0;
  return String(path).split(".").reduce((o, k) => o == null ? void 0 : o[k], obj);
}
function isLocalhost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
function buildPayload(leadData, fieldMap) {
  const out = {};
  for (const f of fieldMap || []) {
    let v = leadData[f.src];
    if (f.transform) v = applyTransform(v, f.transform);
    if (f.required && (v == null || v === "")) continue;
    if (v !== void 0) out[f.dest || f.src] = v;
  }
  return out;
}
async function deliverDirectPost(cfg, ctx) {
  const nowMs = ctx.nowMs ?? 0;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const attemptNumber = cfg.attemptNumber || 1;
  const method = String(cfg.method || "POST").toUpperCase();
  let url;
  try {
    url = new URL(cfg.targetUrl);
  } catch {
    return failClosed(ctx, cfg, nowMs, "invalid_url", "INVALID_URL");
  }
  if (ctx.testMode) {
    const allowed = ctx.allowlistHosts || [];
    if (!isLocalhost(url.hostname) && !allowed.includes(url.hostname)) {
      return failClosed(ctx, cfg, nowMs, "host_not_allowed", "HOST_NOT_ALLOWED");
    }
  } else if (typeof ctx.validateTarget === "function") {
    const check = await ctx.validateTarget(url);
    if (!check || check.ok !== true) {
      return failClosed(ctx, cfg, nowMs, check && check.reason ? check.reason : "target_not_allowed", "SSRF_BLOCKED");
    }
  }
  let finalUrl = cfg.targetUrl;
  if (cfg.queryParamsTemplate && String(cfg.queryParamsTemplate).trim() !== "") {
    let renderedParams;
    try {
      renderedParams = await buildPayloadFromTemplate(cfg.queryParamsTemplate, cfg.leadData || {});
    } catch {
      return failClosed(ctx, cfg, nowMs, "invalid_query_params_template", "INVALID_QUERY_PARAMS_TEMPLATE");
    }
    if (renderedParams === null || typeof renderedParams !== "object" || Array.isArray(renderedParams)) {
      return failClosed(ctx, cfg, nowMs, "invalid_query_params_template", "INVALID_QUERY_PARAMS_TEMPLATE");
    }
    let appended = false;
    for (const [k, v] of Object.entries(renderedParams)) {
      if (v != null) {
        url.searchParams.set(k, String(v));
        appended = true;
      }
    }
    if (appended) finalUrl = url.toString();
  }
  const sendsBody = method !== "GET" && !(method === "DELETE" && !cfg.deleteWithBody);
  let payload;
  if (sendsBody) {
    if (cfg.payloadTemplate && String(cfg.payloadTemplate).trim() !== "") {
      let rendered;
      try {
        rendered = await buildPayloadFromTemplate(cfg.payloadTemplate, cfg.leadData || {});
      } catch {
        return failClosed(ctx, cfg, nowMs, "invalid_payload_template", "INVALID_PAYLOAD_TEMPLATE");
      }
      if (rendered === null || typeof rendered !== "object" || Array.isArray(rendered)) {
        return failClosed(ctx, cfg, nowMs, "invalid_payload_template", "INVALID_PAYLOAD_TEMPLATE");
      }
      payload = rendered;
    } else {
      payload = buildPayload(cfg.leadData || {}, cfg.fieldMap);
    }
  }
  const encoding = cfg.encoding === "form" ? "form" : "json";
  const headers = { ...cfg.headers || {} };
  if (cfg.credentialRef && typeof ctx.resolveCredential === "function") {
    const resolved = await ctx.resolveCredential(cfg.credentialRef);
    if (resolved && typeof resolved === "object") {
      for (const [k, v] of Object.entries(resolved)) {
        if (v != null) headers[k] = v;
      }
    }
  }
  headers["Idempotency-Key"] = cfg.idempotencyKey;
  let body;
  if (sendsBody) {
    if (encoding === "form") {
      headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
      body = new URLSearchParams(payload).toString();
    } else {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      body = JSON.stringify(payload);
    }
  }
  const pending = await ctx.store.createAttempt({
    lead_id: cfg.leadId,
    sub_delivery_id: cfg.subDeliveryId || null,
    destination_id: cfg.destinationId,
    route_member_id: cfg.routeMemberId || null,
    trigger: cfg.trigger || "primary",
    attempt_number: attemptNumber,
    idempotency_key: cfg.idempotencyKey,
    run_idempotency_key: cfg.runIdempotencyKey || null,
    is_primary: !!cfg.isPrimary,
    status: ATTEMPT_STATUS.PENDING,
    started_at: new Date(nowMs).toISOString()
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 1e4);
  let httpStatus = null;
  let bodyText = "";
  let errorClass = null;
  const t0 = nowMs;
  try {
    const resp = await fetchImpl(finalUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal
    });
    httpStatus = resp.status;
    bodyText = await resp.text();
  } catch (e) {
    errorClass = e && e.name === "AbortError" ? "timeout" : e && e.message ? e.message.slice(0, 60) : "network_error";
  } finally {
    clearTimeout(timer);
  }
  const mapping = cfg.responseMapping || {};
  const status = errorClass ? ATTEMPT_STATUS.ERROR : classifyResponse({ httpStatus, body: bodyText, mapping });
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const revenue = status === ATTEMPT_STATUS.ACCEPTED && parsed ? Number(getPath(parsed, mapping.revenuePath)) || 0 : 0;
  const buyerLeadId = parsed ? getPath(parsed, mapping.leadIdPath) ?? null : null;
  const record = buildAttemptRecord({
    leadId: cfg.leadId,
    destinationId: cfg.destinationId,
    trigger: cfg.trigger,
    attemptNumber,
    idempotencyKey: cfg.idempotencyKey,
    isPrimary: cfg.isPrimary,
    status,
    request: { method, url: finalUrl, headers, body: body ?? null },
    response: { status: httpStatus, body: bodyText },
    httpStatus,
    latencyMs: (ctx.nowMs ?? 0) - t0,
    errorClass,
    nowMs,
    retryOpts: cfg.retryOpts
  });
  await ctx.store.updateAttempt(pending.id, record);
  return {
    attemptId: pending.id,
    status: record.status,
    httpStatus,
    revenue,
    buyerLeadId,
    retryable: record.next_retry_at != null,
    nextRetryAt: record.next_retry_at,
    errorClass
  };
}
async function failClosed(ctx, cfg, nowMs, errorClass, code) {
  const rec = await ctx.store.createAttempt({
    lead_id: cfg.leadId,
    destination_id: cfg.destinationId,
    route_member_id: cfg.routeMemberId || null,
    attempt_number: cfg.attemptNumber || 1,
    idempotency_key: cfg.idempotencyKey,
    run_idempotency_key: cfg.runIdempotencyKey || null,
    is_primary: !!cfg.isPrimary,
    status: ATTEMPT_STATUS.ERROR,
    error_class: errorClass,
    code,
    started_at: new Date(nowMs).toISOString(),
    completed_at: new Date(nowMs).toISOString()
  });
  return { attemptId: rec.id, status: ATTEMPT_STATUS.ERROR, code, errorClass, retryable: false, revenue: 0, buyerLeadId: null };
}

// src/lib/distribution/pingpostFlow.js
var PING_ALLOWLIST = ["state", "zip", "county", "vertical", "brand", "supplier", "source", "lead_event"];
function buildPingPayload(leadData, allowlist = PING_ALLOWLIST) {
  const out = {};
  for (const f of allowlist) if (leadData[f] !== void 0 && leadData[f] !== null) out[f] = leadData[f];
  return out;
}
function getPath2(obj, path) {
  if (!path) return void 0;
  return String(path).split(".").reduce((o, k) => o == null ? void 0 : o[k], obj);
}
function isAmbiguous(errorClass) {
  if (!errorClass) return false;
  const e = String(errorClass).toLowerCase();
  if (e.includes("refused") || e.includes("econnrefused") || e === "host_not_allowed" || e === "invalid_url") return false;
  return true;
}
async function sendPing({ url, payload, headers, timeoutMs }, ctx) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 5e3);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers || {} },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: controller.signal
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: true, status: resp.status, json };
  } catch (e) {
    return { ok: false, errorClass: e && e.name === "AbortError" ? "timeout" : e && e.message ? e.message.slice(0, 60) : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
async function runPingPost(cfg, ctx) {
  const nowMs = ctx.nowMs ?? 0;
  const pingPayload = buildPingPayload(cfg.leadData || {}, cfg.pingAllowlist || PING_ALLOWLIST);
  const trace = { ping_payload_fields: Object.keys(pingPayload), bids: [], excluded: [], fallthrough: [] };
  const pinged = await Promise.all((cfg.bidders || []).map(async (b) => {
    const res = await sendPing({ url: b.pingUrl, payload: pingPayload, headers: b.headers, timeoutMs: b.timeoutMs }, ctx);
    const bm = b.bidMapping || { amountPath: "bid", idPath: "bid_id", expiresAtPath: "expires_at_ms" };
    const amount = res.ok ? Number(getPath2(res.json, bm.amountPath)) || 0 : 0;
    const bidId = res.ok ? getPath2(res.json, bm.idPath) ?? null : null;
    const expiresAtMs = res.ok ? Number(getPath2(res.json, bm.expiresAtPath)) || null : null;
    await ctx.store.createBid({
      lead_id: cfg.leadId,
      route_member_id: b.memberId,
      destination_id: b.destinationId,
      ping_sent_at: new Date(nowMs).toISOString(),
      bid_amount: amount,
      bid_id: bidId,
      bid_expires_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      status: res.ok ? "bid" : "error"
    });
    return { bidder: b, amount, bidId, expiresAtMs, ok: res.ok };
  }));
  const eligible = [];
  for (const p of pinged) {
    let reason = null;
    if (!p.ok || !(p.amount > 0)) reason = "NO_BID";
    else if (p.expiresAtMs != null && p.expiresAtMs < nowMs) reason = "BID_EXPIRED";
    else if (p.bidder.reservePrice != null && p.amount < Number(p.bidder.reservePrice)) reason = "BELOW_RESERVE";
    trace.bids.push({ member_id: p.bidder.memberId, amount: p.amount, bid_id: p.bidId, eligible: !reason, reason });
    if (reason) trace.excluded.push({ member_id: p.bidder.memberId, reason });
    else eligible.push(p);
  }
  eligible.sort((a, b) => b.amount - a.amount || String(a.bidder.memberId).localeCompare(String(b.bidder.memberId)));
  if (!eligible.length) return { won: false, reason: "NO_ELIGIBLE_BID", winner: null, postResult: null, trace };
  for (let i = 0; i < eligible.length; i++) {
    const cand = eligible[i];
    const postRes = await deliverDirectPost({
      destinationId: cand.bidder.destinationId,
      targetUrl: cand.bidder.postUrl,
      method: "POST",
      encoding: cand.bidder.encoding || "json",
      headers: cand.bidder.headers,
      fieldMap: cand.bidder.fieldMap,
      timeoutMs: cand.bidder.timeoutMs,
      responseMapping: cand.bidder.responseMapping,
      idempotencyKey: `${cfg.idempotencyKey}:${cand.bidder.memberId}`,
      leadData: cfg.leadData,
      leadId: cfg.leadId,
      attemptNumber: 1,
      isPrimary: true,
      trigger: "pingpost_win"
    }, ctx);
    if (postRes.status === ATTEMPT_STATUS.ACCEPTED) {
      return { won: true, winner: cand.bidder.memberId, price: cand.amount, postResult: postRes, trace };
    }
    if (postRes.status === ATTEMPT_STATUS.ERROR && isAmbiguous(postRes.errorClass)) {
      trace.ambiguous = { member_id: cand.bidder.memberId, error_class: postRes.errorClass };
      return { won: false, reason: "AMBIGUOUS_WINNER", winner: cand.bidder.memberId, postResult: postRes, needsReconciliation: true, trace };
    }
    trace.fallthrough.push({ member_id: cand.bidder.memberId, status: postRes.status });
  }
  return { won: false, reason: "ALL_WINNERS_FAILED", winner: null, postResult: null, trace };
}

// src/lib/distribution/distribute.js
var groupOrder = (g) => g.orderIndex ?? g.order_index ?? 0;
function weightedPermutation(members, seedKey) {
  const remaining = [...members];
  const out = [];
  let i = 0;
  while (remaining.length) {
    const pick = selectWeighted(remaining, `${seedKey}:${i++}`) || remaining[0];
    out.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return out;
}
function orderEligible(group, members, seed = {}) {
  const list = [...members];
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  switch (group.method) {
    case "auction":
      return list.sort((a, b) => resolvePrice(b) - resolvePrice(a) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || byId(a, b));
    case "hybrid": {
      const priceW = group.price_weight ?? group.weights?.price ?? 0.5;
      const prioW = group.priority_weight ?? group.weights?.priority ?? 0.5;
      const prices = list.map(resolvePrice);
      const maxPrice = Math.max(1, ...prices);
      const maxPrio = Math.max(1, ...list.map((m) => m.priority ?? 1));
      return list.map((m, i) => ({ m, s: priceW * (prices[i] / maxPrice) + prioW * (1 - ((m.priority ?? 1) - 1) / maxPrio) })).sort((a, b) => b.s - a.s || byId(a.m, b.m)).map((x) => x.m);
    }
    case "round_robin": {
      const ordered = [...list].sort(byId);
      if (!ordered.length) return ordered;
      const cur = ((Number(seed.rrCursor) || 0) % ordered.length + ordered.length) % ordered.length;
      return ordered.slice(cur).concat(ordered.slice(0, cur));
    }
    case "weighted":
      return weightedPermutation(list, String(seed.key || ""));
    case "priority":
    default:
      return list.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || byId(a, b));
  }
}
async function distributeLead(input) {
  const {
    campaign,
    groups = [],
    lead = {},
    seed = {},
    nowMs = 0,
    evalConditions,
    deliver,
    maxAttemptsPerDest = 1,
    terminalOnDuplicate = true
  } = input;
  const result = {
    campaign_eligible: true,
    candidates: [],
    // every member evaluated, with eligibility + reason
    ordered: [],
    // eligible member ids in submit order
    attempts: [],
    // one row per delivery attempt
    winner: null,
    price: 0,
    revenue: 0,
    finalStatus: "NoEligibleDestination",
    reason: null
  };
  if (campaign && (campaign.active === false || campaign.status && campaign.status !== "active")) {
    result.campaign_eligible = false;
    result.finalStatus = "CampaignInactive";
    result.reason = "CAMPAIGN_INACTIVE";
    return result;
  }
  const orderedGroups = groups.filter((g) => g.active !== false).sort((a, b) => groupOrder(a) - groupOrder(b));
  const ordered = [];
  for (const g of orderedGroups) {
    const evals = (g.members || []).map((m) => ({
      m,
      res: evaluateMember(m, lead, { enforceReserve: g.method === "auction", evalConditions, nowMs })
    }));
    for (const e of evals) {
      result.candidates.push({ group_id: g.id, member_id: e.m.id, eligible: e.res.eligible, reason: e.res.reason, price: resolvePrice(e.m) });
    }
    const eligible = evals.filter((e) => e.res.eligible).map((e) => e.m);
    for (const m of orderEligible(g, eligible, seed)) ordered.push({ group: g, member: m });
  }
  result.ordered = ordered.map((o) => o.member.id);
  if (!ordered.length) {
    result.finalStatus = "NoEligibleDestination";
    result.reason = REASON.NO_ELIGIBLE_MEMBER;
    return result;
  }
  for (const cand of ordered) {
    let attempt = 1;
    while (true) {
      const out = await deliver(cand.member, { attemptNumber: attempt, group: cand.group, lead, nowMs, seed });
      result.attempts.push({
        member_id: cand.member.id,
        attempt,
        status: out.status,
        http_status: out.httpStatus ?? null,
        error_class: out.errorClass ?? null,
        revenue: out.revenue ?? 0,
        payload: out.payload ?? null,
        response: out.response ?? null
      });
      if (out.status === ATTEMPT_STATUS.ACCEPTED) {
        result.winner = cand.member.id;
        result.price = resolvePrice(cand.member);
        result.revenue = out.revenue ?? 0;
        result.finalStatus = "Sold";
        result.reason = "ACCEPTED";
        return result;
      }
      if (out.status === ATTEMPT_STATUS.DUPLICATE && terminalOnDuplicate) {
        result.winner = cand.member.id;
        result.finalStatus = "Duplicate";
        result.reason = "DUPLICATE";
        return result;
      }
      if (out.status === ATTEMPT_STATUS.ERROR && out.retryable && attempt < maxAttemptsPerDest) {
        attempt += 1;
        continue;
      }
      break;
    }
  }
  result.finalStatus = "Exhausted";
  result.reason = "ALL_DESTINATIONS_EXHAUSTED";
  return result;
}

// src/lib/distribution/deliveryStore.js
function makeInMemoryAttemptStore({ yieldFn } = {}) {
  const attempts = [];
  const bids = [];
  let seq = 0;
  const microYield = yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
  return {
    async createAttempt(rec) {
      const row = { ...rec, id: "a" + ++seq };
      attempts.push(row);
      return row;
    },
    async updateAttempt(id, patch) {
      const a = attempts.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
      return a;
    },
    async getAttempt(id) {
      return attempts.find((x) => x.id === id) || null;
    },
    async listDue(nowMs) {
      return attempts.filter((a) => a.status === "error" && a.next_retry_at != null && Date.parse(a.next_retry_at) <= nowMs && (a.lease_until == null || Date.parse(a.lease_until) <= nowMs));
    },
    // Atomic lease claim (honest CAS on lease_version, and on status when the
    // caller supplies requiredStatus). Exactly one concurrent worker wins an
    // unleased (or expired-lease) attempt. The optional status check closes a
    // real gap a lease-only CAS leaves open: the automatic retry worker reads
    // due attempts filtered to status:'error' (listDue) and must not resurrect
    // one that a concurrent completion (a manual retry, or another worker)
    // already moved to a different terminal status between that read and this
    // claim - it passes requiredStatus:'error' so the claim itself fails
    // atomically in that case. manualRetry intentionally omits it: an operator
    // retrying a specific attempt by id may deliberately target one that is
    // no longer 'error' (e.g. dead_letter), and the lease CAS alone still
    // prevents two concurrent claims of the same row.
    async claimLease(id, workerId, nowMs, leaseMs, requiredStatus) {
      const a = attempts.find((x) => x.id === id);
      if (!a) return false;
      const version = a.lease_version || 0;
      await microYield();
      const latest = attempts.find((x) => x.id === id);
      if (requiredStatus && latest.status !== requiredStatus) return false;
      const activeLease = latest.lease_until ? Date.parse(latest.lease_until) : 0;
      if (activeLease > nowMs) return false;
      if ((latest.lease_version || 0) !== version) return false;
      latest.lease_until = new Date(nowMs + leaseMs).toISOString();
      latest.leased_by = workerId;
      latest.lease_version = version + 1;
      return true;
    },
    // BidAttempt persistence (ping-post).
    async createBid(rec) {
      const row = { ...rec, id: "b" + ++seq };
      bids.push(row);
      return row;
    },
    async updateBid(id, patch) {
      const b = bids.find((x) => x.id === id);
      if (b) Object.assign(b, patch);
      return b;
    },
    _debug: { attempts, bids }
  };
}
function makeEntityAttemptStore(db) {
  return {
    async createAttempt(rec) {
      return db.entities.DeliveryAttempt.create(rec);
    },
    async updateAttempt(id, patch) {
      return db.entities.DeliveryAttempt.update(id, patch);
    },
    async getAttempt(id) {
      const rows = await db.entities.DeliveryAttempt.filter({ id });
      return rows[0] || null;
    },
    async listDue(nowMs, limit = 100) {
      const iso = new Date(nowMs).toISOString();
      const rows = await db.entities.DeliveryAttempt.filter({ status: "error" }, "next_retry_at", limit);
      return rows.filter((a) => a.next_retry_at && a.next_retry_at <= iso && (!a.lease_until || a.lease_until <= iso));
    },
    async claimLease(id, workerId, nowMs, leaseMs, requiredStatus) {
      const rows = await db.entities.DeliveryAttempt.filter({ id });
      const a = rows[0];
      if (!a) return false;
      if (requiredStatus && a.status !== requiredStatus) return false;
      const activeLease = a.lease_until ? Date.parse(a.lease_until) : 0;
      if (activeLease > nowMs) return false;
      const version = a.lease_version || 0;
      const match = requiredStatus ? { id, lease_version: version, status: requiredStatus } : { id, lease_version: version };
      const res = await db.entities.DeliveryAttempt.updateMany(
        match,
        { $set: { lease_until: new Date(nowMs + leaseMs).toISOString(), leased_by: workerId, lease_version: version + 1 } }
      );
      return !!(res && res.updated > 0);
    },
    async createBid(rec) {
      return db.entities.BidAttempt.create(rec);
    },
    async updateBid(id, patch) {
      return db.entities.BidAttempt.update(id, patch);
    }
  };
}

// src/lib/distribution/distributeRun.js
var RUN = {
  ACCEPTED: "accepted",
  DUPLICATE: "duplicate",
  NO_ELIGIBLE: "no_eligible_member",
  REJECTED: "rejected",
  ERROR_CLEAN: "error_clean",
  AMBIGUOUS: "ambiguous",
  SKIPPED: "skipped"
};
var CAP_WINDOWS3 = ["total", "hourly", "daily", "weekly", "monthly"];
function capScopesFor(member, nowMs, tzOffsetMinutes = 0) {
  const scopes = [];
  const caps = member.caps || {};
  for (const w of CAP_WINDOWS3) {
    const cfg = caps[w];
    if (!cfg || cfg.limit == null) continue;
    const bucket = w === "total" ? "all" : capWindowStart(nowMs, w, tzOffsetMinutes);
    scopes.push({
      key: capScopeKey(member.id, w, bucket),
      limit: Number(cfg.limit),
      window: w,
      windowStart: w === "total" ? null : bucket,
      memberId: member.id,
      scopeType: "route_member"
    });
  }
  return scopes;
}
function walletPolicyFor(member) {
  const w = member.wallet;
  if (!w) return null;
  if (w.enforce && w.creditLimit != null) return { creditLimit: Number(w.creditLimit) };
  if (w.mode === "prepaid") return { creditLimit: Infinity };
  return null;
}
async function isLeadAlreadySold(capStore, leadId) {
  if (!leadId || !capStore) return false;
  return capStore.isClaimed(winnerClaimKey(leadId));
}
function winnerClaimKey(leadId) {
  return `winner:${leadId}`;
}
async function reserveAndDeliver({ member, meta, stores, ctx, sink }) {
  const { attemptStore, capStore, walletStore } = stores;
  const nowMs = ctx.nowMs;
  const price = resolvePrice(member);
  const attemptNumber = meta && meta.attemptNumber || 1;
  const trigger = meta && meta.trigger || "primary";
  const memberKey = `${ctx.idempotencyKey}:${member.id}`;
  if (await isLeadAlreadySold(capStore, ctx.leadId)) {
    return { status: ATTEMPT_STATUS.SUPERSEDED, reason: "LEAD_ALREADY_SOLD", revenue: 0, retryable: false, wonLead: false };
  }
  const scopes = capScopesFor(member, nowMs, ctx.tzOffsetMinutes || 0);
  let reservation = null;
  if (scopes.length) {
    const res = await reserve(capStore, {
      idempotencyKey: `${ctx.idempotencyKey}:${attemptNumber}`,
      leadId: ctx.leadId,
      memberId: member.id,
      price,
      scopes
    });
    if (!res.ok) {
      return { status: ATTEMPT_STATUS.REJECTED, reason: res.code || RESERVE.CAP_EXCEEDED, revenue: 0, retryable: false };
    }
    reservation = res.reservation;
    if (res.code === RESERVE.ALREADY_RESERVED) {
      return { status: ATTEMPT_STATUS.REJECTED, reason: "ALREADY_RESERVED", revenue: 0, retryable: false };
    }
  }
  const cfg = member.delivery;
  if (!cfg || !cfg.targetUrl) {
    if (reservation) await release(capStore, reservation);
    return { status: ATTEMPT_STATUS.ERROR, errorClass: "no_endpoint", revenue: 0, retryable: false };
  }
  let out;
  try {
    out = await deliverDirectPost({
      ...cfg,
      destinationId: member.destinationId || null,
      routeMemberId: member.id,
      leadId: ctx.leadId,
      leadData: ctx.leadData,
      idempotencyKey: memberKey,
      // The bare, non-member-scoped run key, persisted alongside the
      // combined one so a LATER async retry (which only has the stored
      // attempt row, not this closure's ctx) can pass it back in as its own
      // ctx.idempotencyKey and reconstruct the IDENTICAL outbound
      // Idempotency-Key header - never a different one for the same logical
      // attempt, which would defeat the buyer's own dedup and increase,
      // rather than close, the double-accept risk a retry already carries.
      runIdempotencyKey: ctx.idempotencyKey,
      attemptNumber,
      isPrimary: trigger === "primary" && attemptNumber === 1,
      trigger
    }, {
      store: attemptStore,
      nowMs,
      fetchImpl: ctx.fetchImpl,
      testMode: !!ctx.testMode,
      allowlistHosts: ctx.allowlistHosts || [],
      resolveCredential: ctx.resolveCredential,
      validateTarget: ctx.validateTarget
    });
  } catch (err) {
    if (reservation) await release(capStore, reservation);
    return {
      status: ATTEMPT_STATUS.ERROR,
      errorClass: String(err && err.message || err).slice(0, 60),
      revenue: 0,
      retryable: false
    };
  }
  if (ctx.healthStore) {
    try {
      await ctx.healthStore.recordResult(
        { subDeliveryId: member.subDeliveryId || null, destinationId: member.destinationId || null },
        out.status === ATTEMPT_STATUS.ACCEPTED,
        nowMs,
        ctx.healthOpts
      );
    } catch {
    }
  }
  if (out.status === ATTEMPT_STATUS.ACCEPTED) {
    const won = await capStore.claim(winnerClaimKey(ctx.leadId));
    if (!won) {
      if (reservation) await release(capStore, reservation);
      if (out.attemptId) {
        try {
          await attemptStore.updateAttempt(out.attemptId, { status: ATTEMPT_STATUS.SUPERSEDED });
        } catch {
        }
      }
      if (sink) sink.balanceDecision = "superseded_duplicate_sale";
      return {
        status: ATTEMPT_STATUS.SUPERSEDED,
        revenue: 0,
        httpStatus: out.httpStatus ?? null,
        retryable: false,
        attemptId: out.attemptId,
        balanceDecision: "superseded_duplicate_sale",
        wonLead: false
      };
    }
    if (reservation) await finalize(capStore, reservation);
    const policy = walletPolicyFor(member);
    if (policy && price > 0) {
      try {
        const debit = await walletDebit(walletStore, {
          buyerId: member.buyerId,
          amount: price,
          idempotencyKey: `sale:${memberKey}`,
          creditLimit: policy.creditLimit,
          type: "debit",
          description: `lead ${ctx.leadId}`
        });
        out.balanceDecision = debit.applied ? "debited" : debit.duplicate ? "duplicate" : debit.code || "not_applied";
      } catch {
        out.balanceDecision = "debit_error";
      }
      if (sink) sink.balanceDecision = out.balanceDecision;
    } else if (sink) {
      sink.balanceDecision = "not_applicable";
    }
  } else if (reservation) {
    await release(capStore, reservation);
  }
  return {
    status: out.status,
    revenue: out.revenue || 0,
    httpStatus: out.httpStatus ?? null,
    errorClass: out.errorClass ?? null,
    retryable: !!out.retryable,
    attemptId: out.attemptId,
    buyerLeadId: out.buyerLeadId ?? null,
    balanceDecision: out.balanceDecision ?? null,
    wonLead: out.status === ATTEMPT_STATUS.ACCEPTED
  };
}
function makeDeliver({ stores, ctx, sink }) {
  return async function deliver(member, meta) {
    return reserveAndDeliver({ member, meta, stores, ctx, sink });
  };
}
function toRunStatus(result) {
  switch (result.finalStatus) {
    case "Sold":
      return RUN.ACCEPTED;
    case "Duplicate":
      return RUN.DUPLICATE;
    case "NoEligibleDestination":
      return RUN.NO_ELIGIBLE;
    case "CampaignInactive":
      return RUN.NO_ELIGIBLE;
    case "Exhausted": {
      const ambiguous = (result.attempts || []).some(
        (a) => a.status === ATTEMPT_STATUS.ERROR && ["timeout", "network_error"].includes(String(a.error_class || "")) || a.status === ATTEMPT_STATUS.QUEUED || a.status === ATTEMPT_STATUS.SUPERSEDED
      );
      if (ambiguous) return RUN.AMBIGUOUS;
      const anyDelivered = (result.attempts || []).some((a) => a.status === ATTEMPT_STATUS.REJECTED);
      return anyDelivered ? RUN.REJECTED : RUN.ERROR_CLEAN;
    }
    default:
      return RUN.ERROR_CLEAN;
  }
}
async function runDistribution(db, ctx) {
  const nowMs = ctx.nowMs ?? 0;
  const trace = async (patch) => {
    try {
      await db.entities.RouteDecisionTrace.create({
        lead_id: ctx.leadId,
        idempotency_key: ctx.idempotencyKey || null,
        distribution_mode: ctx.distributionMode || "unknown",
        created_at: new Date(nowMs).toISOString(),
        ...patch
      });
    } catch {
    }
  };
  try {
    const hasGroups = ctx.snapshot ? true : await hasActiveRouteGroup(db, ctx.campaignId, nowMs);
    if (!hasGroups) {
      await trace({ result: "no_route_config", winner_member_id: "", evaluated_candidates: "[]", fallthrough_path: "[]" });
      return { ran: false, status: RUN.NO_ELIGIBLE, reason: "no_route_config" };
    }
    const snap = ctx.snapshot || await loadRoutingSnapshot(db, {
      campaignId: ctx.campaignId,
      nowMs,
      leadState: (ctx.leadData || {}).state
    });
    const stores = ctx.stores || {
      attemptStore: makeEntityAttemptStore(db),
      capStore: makeEntityCapStore(db),
      walletStore: makeEntityWalletStore(db)
    };
    const healthStore = ctx.healthStore !== void 0 ? ctx.healthStore : makeEntityHealthStore(db);
    const t0 = nowMs;
    const sink = {};
    const result = await distributeLead({
      campaign: ctx.campaign || null,
      groups: snap.groups,
      lead: ctx.leadData || {},
      seed: { key: ctx.idempotencyKey || "" },
      nowMs,
      evalConditions: (t, d) => evalConditionTree(t, d, { nowMs }),
      deliver: makeDeliver({ db, stores, ctx: { ...ctx, nowMs, healthStore }, sink }),
      maxAttemptsPerDest: ctx.maxAttemptsPerDest || 1
    });
    const status = toRunStatus(result);
    const winnerRow = result.winner ? snap.groups.flatMap((g) => g.members).find((m) => m.id === result.winner) || null : null;
    await trace({
      result: status,
      evaluated_candidates: JSON.stringify(result.candidates || []),
      winner_member_id: result.winner || "",
      price: result.price || 0,
      fallthrough_path: JSON.stringify(result.ordered || []),
      config_version: snap.configHash || null,
      balance_decision: sink.balanceDecision || null,
      eval_latency_ms: nowMs - t0
    });
    return {
      ran: true,
      status,
      winnerMemberId: result.winner || null,
      buyerId: winnerRow ? winnerRow.buyerId : null,
      subDeliveryId: winnerRow ? winnerRow.subDeliveryId : null,
      price: result.price || 0,
      revenue: result.revenue || 0,
      result
    };
  } catch (err) {
    await trace({
      result: "evaluation_error",
      winner_member_id: "",
      evaluated_candidates: "[]",
      fallthrough_path: "[]",
      error_message: String(err && err.message || err).slice(0, 300)
    });
    return { ran: false, status: RUN.ERROR_CLEAN, reason: "evaluation_error", error: String(err && err.message || err) };
  }
}

// src/lib/distribution/campaignResolve.js
var CAMPAIGN_MATCH = {
  BY_CODE: "campaign_code",
  BY_RECORD_ID: "campaign_record_id",
  BY_NAME: "campaign_name",
  BY_VERTICAL: "vertical",
  NONE: "no_match",
  UNKNOWN_CODE: "unknown_campaign_id"
};
function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}
function isLive(c) {
  if (!c) return false;
  if (c.active === false) return false;
  const status = norm(c.status);
  return status === "" || status === "active";
}
function resolveCampaign(lead, campaigns) {
  const list = (campaigns || []).filter(isLive);
  const posted = norm(lead && (lead.campaign_id ?? lead._campaign));
  if (posted) {
    const byCode = list.find((c) => norm(c.campaign_id) === posted);
    if (byCode) return hit(byCode, CAMPAIGN_MATCH.BY_CODE);
    const byRecordId = list.find((c) => norm(c.id) === posted);
    if (byRecordId) return hit(byRecordId, CAMPAIGN_MATCH.BY_RECORD_ID);
    const byName = list.find((c) => norm(c.name) === posted);
    if (byName) return hit(byName, CAMPAIGN_MATCH.BY_NAME);
    return {
      campaign: null,
      campaignId: null,
      matchedBy: CAMPAIGN_MATCH.UNKNOWN_CODE,
      reason: `Posted campaign_id "${String(lead && (lead.campaign_id ?? lead._campaign) || "").slice(0, 40)}" did not match an active campaign`
    };
  }
  const vertical = norm(lead && (lead.vertical ?? lead.lead_vertical));
  if (vertical) {
    const byVertical = list.find((c) => norm(c.vertical) === vertical) || list.find((c) => norm(c.name) === vertical);
    if (byVertical) return hit(byVertical, CAMPAIGN_MATCH.BY_VERTICAL);
  }
  return {
    campaign: null,
    campaignId: null,
    matchedBy: CAMPAIGN_MATCH.NONE,
    reason: vertical ? `No active campaign for vertical "${vertical}"` : "Lead carries no campaign_id and no vertical"
  };
}
function hit(campaign, matchedBy) {
  return { campaign, campaignId: campaign.id, matchedBy, reason: null };
}

// src/lib/distribution/retryWorker.js
function seededUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1e3 / 1e3;
}
function backoffWithJitter(attemptNumber, seed, opts = {}) {
  const base = computeBackoffMs(attemptNumber, opts);
  const u = opts.rng ? opts.rng() : seededUnit(`${seed}:${attemptNumber}`);
  return Math.min(opts.maxMs ?? 36e5, Math.round(base * (0.5 + 0.5 * u)));
}
var DEFAULT_LEASE_MS = 9e4;
async function runRetryWorker(store, deliverFn, ctx) {
  const { nowMs, workerId, leaseMs = DEFAULT_LEASE_MS, healthStore, maxAttempts = 5, retryOpts = {}, isLeadSold, now } = ctx;
  const clock = typeof now === "function" ? now : () => nowMs;
  const due = await store.listDue(nowMs);
  const processed = [];
  for (const a of due) {
    const claimNowMs = clock();
    const won = await store.claimLease(a.id, workerId, claimNowMs, leaseMs, "error");
    if (!won) continue;
    if (typeof isLeadSold === "function" && await isLeadSold(a.lead_id)) {
      await store.updateAttempt(a.id, { status: ATTEMPT_STATUS.SUPERSEDED, next_retry_at: null, lease_until: null });
      processed.push({ id: a.id, worker: workerId, status: ATTEMPT_STATUS.SUPERSEDED });
      continue;
    }
    const nextAttemptNum = (a.attempt_number || 1) + 1;
    const res = await deliverFn({ ...a, attempt_number: nextAttemptNum });
    const success = res.status === ATTEMPT_STATUS.ACCEPTED;
    const settleNowMs = clock();
    if (healthStore) {
      await healthStore.recordResult(
        { subDeliveryId: a.sub_delivery_id || null, destinationId: a.destination_id || null },
        success,
        settleNowMs,
        ctx.healthOpts
      );
    }
    if (success || res.status === ATTEMPT_STATUS.REJECTED || res.status === ATTEMPT_STATUS.DUPLICATE || res.status === ATTEMPT_STATUS.SUPERSEDED) {
      await store.updateAttempt(a.id, { status: res.status, next_retry_at: null, lease_until: null, attempt_number: nextAttemptNum });
    } else if (nextAttemptNum >= maxAttempts || res.retryable === false) {
      await store.updateAttempt(a.id, { status: ATTEMPT_STATUS.DEAD_LETTER, next_retry_at: null, lease_until: null, attempt_number: nextAttemptNum });
    } else {
      const delay = backoffWithJitter(nextAttemptNum, a.id, retryOpts);
      await store.updateAttempt(a.id, {
        status: ATTEMPT_STATUS.ERROR,
        attempt_number: nextAttemptNum,
        next_retry_at: new Date(settleNowMs + delay).toISOString(),
        lease_until: null
      });
    }
    processed.push({ id: a.id, worker: workerId, status: res.status });
  }
  return processed;
}
async function manualRetry(store, attemptId, deliverFn, ctx) {
  const a = await store.getAttempt(attemptId);
  if (!a) return { ok: false, reason: "not_found" };
  const won = await store.claimLease(attemptId, ctx.workerId || "manual", ctx.nowMs, ctx.leaseMs || DEFAULT_LEASE_MS);
  if (!won) return { ok: false, reason: "leased" };
  if (typeof ctx.isLeadSold === "function" && await ctx.isLeadSold(a.lead_id)) {
    await store.updateAttempt(attemptId, { status: ATTEMPT_STATUS.SUPERSEDED, next_retry_at: null, lease_until: null });
    return { ok: true, status: ATTEMPT_STATUS.SUPERSEDED };
  }
  const nextAttemptNum = (a.attempt_number || 1) + 1;
  const res = await deliverFn({ ...a, attempt_number: nextAttemptNum });
  await store.updateAttempt(attemptId, {
    status: res.status,
    lease_until: null,
    attempt_number: nextAttemptNum,
    next_retry_at: res.status === ATTEMPT_STATUS.ERROR ? new Date(ctx.nowMs).toISOString() : null
  });
  if (ctx.healthStore) {
    await ctx.healthStore.recordResult(
      { subDeliveryId: a.sub_delivery_id || null, destinationId: a.destination_id || null },
      res.status === ATTEMPT_STATUS.ACCEPTED,
      ctx.nowMs,
      ctx.healthOpts
    );
  }
  return { ok: true, status: res.status };
}

// src/lib/distribution/pingpost.js
var BID_REASON = {
  ELIGIBLE: "ELIGIBLE",
  BID_EXPIRED: "BID_EXPIRED",
  BELOW_RESERVE: "BELOW_RESERVE",
  NO_BID: "NO_BID",
  NO_ELIGIBLE_BID: "NO_ELIGIBLE_BID"
};
function rankBids(bids, opts = {}) {
  const nowMs = opts.nowMs;
  const reserve2 = opts.reservePrice != null ? Number(opts.reservePrice) : null;
  const evaluated = (bids || []).map((b) => {
    const amount = Number(b.amount);
    let reason = BID_REASON.ELIGIBLE;
    if (!(amount > 0)) reason = BID_REASON.NO_BID;
    else if (b.expiresAtMs != null && nowMs != null && b.expiresAtMs < nowMs) reason = BID_REASON.BID_EXPIRED;
    else if (reserve2 != null && amount < reserve2) reason = BID_REASON.BELOW_RESERVE;
    return { ...b, amount, reason };
  });
  const eligible = evaluated.filter((b) => b.reason === BID_REASON.ELIGIBLE);
  eligible.sort((a, b) => b.amount - a.amount || String(a.id).localeCompare(String(b.id)));
  return {
    winner: eligible[0] || null,
    winnerReason: eligible.length ? BID_REASON.ELIGIBLE : BID_REASON.NO_ELIGIBLE_BID,
    ranked: eligible,
    excluded: evaluated.filter((b) => b.reason !== BID_REASON.ELIGIBLE).map((b) => ({ id: b.id, reason: b.reason }))
  };
}

// src/lib/distribution/shadowCompare.js
var COMPARE = {
  EXACT_MATCH: "exact_match",
  // both routed identically, or both declined
  BUYER_MISMATCH: "buyer_mismatch",
  DESTINATION_MISMATCH: "destination_mismatch",
  PRICE_MISMATCH: "price_mismatch",
  STATUS_MISMATCH: "status_mismatch",
  LEGACY_ONLY: "legacy_only",
  // legacy routed, native did not
  NATIVE_ONLY: "native_only",
  // native routed, legacy did not
  QUALIFICATION_MISMATCH: "qualification_mismatch",
  CONFIGURATION_ERROR: "configuration_error",
  EVALUATION_ERROR: "evaluation_error"
};
var AGREE = /* @__PURE__ */ new Set([COMPARE.EXACT_MATCH]);
function eqNum(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 5e-3;
}
function compareDecision(legacy = {}, native = {}) {
  if (native.evalError) return cat(COMPARE.EVALUATION_ERROR);
  if (native.configError) return cat(COMPARE.CONFIGURATION_ERROR);
  const lr = !!legacy.routed;
  const nr = !!native.routed;
  if (!lr && !nr) return cat(COMPARE.EXACT_MATCH);
  if (lr && !nr) {
    if (String(native.legacyBuyerExcludedReason || "").toUpperCase().includes("QUALIFICATION")) {
      return cat(COMPARE.QUALIFICATION_MISMATCH);
    }
    return cat(COMPARE.LEGACY_ONLY);
  }
  if (!lr && nr) return cat(COMPARE.NATIVE_ONLY);
  if (String(legacy.buyerId) !== String(native.buyerId)) return cat(COMPARE.BUYER_MISMATCH);
  if (String(legacy.destinationId) !== String(native.destinationId)) return cat(COMPARE.DESTINATION_MISMATCH);
  if (!eqNum(legacy.price, native.price)) return cat(COMPARE.PRICE_MISMATCH);
  if (String(legacy.status || "").toLowerCase() !== String(native.status || "").toLowerCase()) return cat(COMPARE.STATUS_MISMATCH);
  return cat(COMPARE.EXACT_MATCH);
}
function cat(category) {
  return { category, agree: AGREE.has(category) };
}
function summarizeComparisons(pairs) {
  const counts = Object.fromEntries(Object.values(COMPARE).map((c) => [c, 0]));
  for (const p of pairs || []) counts[compareDecision(p.legacy, p.native).category] += 1;
  const total = (pairs || []).length;
  const agreements = counts[COMPARE.EXACT_MATCH];
  const discrepancies = total - agreements;
  return { total, counts, agreements, discrepancies, discrepancyRate: total ? round4(discrepancies / total) : 0 };
}
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

// src/lib/distribution/operatorAuth.js
var OPERATOR_PERMISSION_KEYS = ["leads", "reports", "overview", "finances", "distribution", "operations"];
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === "supplier" || caller.base_role === "buyer") return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === "string" ? JSON.parse(caller.permissions || "{}") : caller.permissions || {};
  } catch {
    permissions = {};
  }
  return caller.role === "admin" || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// src/lib/distribution/configPublish.js
function computeConfigHash(group, members) {
  const material = JSON.stringify({
    g: [group.id, group.method, group.order_index, group.price_weight, group.priority_weight],
    m: (members || []).map((m) => [
      // sub_delivery_id is the CANONICAL destination pointer; destination_id
      // is deprecated compatibility only (see RouteMember.json). Omitting it
      // meant repointing a member from one SubDelivery to another under the
      // same buyer produced no diff and an unchanged hash - a real gap
      // against RouteConfigVersion's own explainability guarantee.
      m.id,
      m.buyer_id,
      m.destination_id,
      m.sub_delivery_id,
      m.active,
      m.priority,
      m.weight,
      m.reserve_price,
      m.price_mode,
      m.fixed_price,
      m.filters,
      m.conditions,
      m.caps,
      m.schedule
    ])
  });
  let h = 2166136261;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function validateConfigForPublish({ group, members, buyers, destinations, subDeliveries, deliveries, buyerStateCpls }, nowMs) {
  const errors = [];
  if (!group || !group.campaign_id) errors.push({ code: "CONFIG_INVALID", detail: "group missing campaign" });
  if (!members || members.length === 0) errors.push({ code: "CONFIG_INVALID", detail: "group has no members" });
  const snap = buildRoutingSnapshot(
    { groups: [{ ...group, active: true, lifecycle: "active" }], members, buyers, destinations, subDeliveries, deliveries, health: [] },
    { campaignId: group && group.campaign_id, nowMs: nowMs ?? 0 }
  );
  for (const e of snap.configErrors) errors.push(e);
  const buyerById = index(buyers, "id");
  const destById = index(destinations, "id");
  const subById = index(subDeliveries, "id");
  const delById = index(deliveries, "id");
  for (const m of members || []) {
    const b = buyerById[m.buyer_id];
    if (!b) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "buyer not found" });
    else if (!(String(b.status).toLowerCase() === "active" && b.active === true)) {
      errors.push({ member_id: m.id, code: "BUYER_INELIGIBLE", detail: "buyer not active" });
    }
    if (m.price_mode === "rule" && Array.isArray(buyerStateCpls)) {
      const hasCoverage = buyerStateCpls.some((r) => String(r.buyer_id) === String(m.buyer_id) && r.active !== false);
      if (!hasCoverage) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "rule-mode member: buyer has no active BuyerStateCpl coverage" });
    }
    if (m.sub_delivery_id) {
      const sd = subById[m.sub_delivery_id];
      if (!sd) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "sub-delivery not found" });
      else {
        if (sd.active === false) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "sub-delivery inactive" });
        const del = delById[sd.delivery_id];
        if (!del) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "parent delivery not found" });
        else {
          if (String(del.status) !== "active") errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "parent delivery not active" });
          if (String(del.buyer_id) !== String(m.buyer_id)) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "sub-delivery belongs to a different buyer" });
        }
        if (!sd.target_url) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "sub-delivery missing target_url" });
        if (!sd.response_mapping || String(sd.response_mapping).trim() === "") errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "sub-delivery missing response mapping" });
      }
    } else if (!destById[m.destination_id]) {
      errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "destination not found" });
    }
    if (m.price_mode === "fixed" && !(Number(m.fixed_price) >= 0)) errors.push({ member_id: m.id, code: "CONFIG_INVALID", detail: "invalid price" });
  }
  return { valid: errors.length === 0, errors, configHash: group ? computeConfigHash(group, members) : null };
}
function buildVersionSnapshot(group, members) {
  return JSON.stringify({ group: sanitizeGroup(group), members: (members || []).map(sanitizeMember) });
}
function diffConfig(oldCfg, newCfg) {
  const changes = [];
  const g0 = oldCfg && oldCfg.group || {};
  const g1 = newCfg && newCfg.group || {};
  for (const k of ["method", "order_index", "price_weight", "priority_weight"]) {
    if (String(g0[k]) !== String(g1[k])) changes.push({ scope: "group", field: k, from: g0[k] ?? null, to: g1[k] ?? null });
  }
  const m0 = index(oldCfg && oldCfg.members, "id");
  const m1 = index(newCfg && newCfg.members, "id");
  for (const id of /* @__PURE__ */ new Set([...Object.keys(m0), ...Object.keys(m1)])) {
    if (!m0[id]) changes.push({ scope: "member", id, change: "added" });
    else if (!m1[id]) changes.push({ scope: "member", id, change: "removed" });
    else for (const k of ["buyer_id", "destination_id", "sub_delivery_id", "active", "priority", "weight", "price_mode", "fixed_price", "reserve_price", "conditions", "filters", "caps", "schedule"]) {
      if (JSON.stringify(m0[id][k]) !== JSON.stringify(m1[id][k])) changes.push({ scope: "member", id, field: k, from: m0[id][k] ?? null, to: m1[id][k] ?? null });
    }
  }
  return changes;
}
function resolveTraceVersion(configHash, versions) {
  return (versions || []).find((v) => String(v.config_hash) === String(configHash)) || null;
}
function index(arr, key) {
  const o = {};
  for (const r of arr || []) o[String(r[key])] = r;
  return o;
}
function sanitizeGroup(g) {
  const { published_by, ...rest } = g || {};
  void published_by;
  return rest;
}
function sanitizeMember(m) {
  return m;
}

// src/lib/distribution/modeControl.js
var MODES = ["legacy_only", "shadow", "canary", "new_primary_with_legacy_fallback", "new_only"];
function isCanaryLead(lead, allowlist = {}) {
  const l = lead || {};
  if (allowlist.supplierKeys && allowlist.supplierKeys.includes(l._supplier_key)) return true;
  if (allowlist.campaignIds && allowlist.campaignIds.includes(l.campaign_id)) return true;
  if (allowlist.sourceMarker && String(l.source || "") === allowlist.sourceMarker) return true;
  return false;
}
function planExecution(mode, lead, opts = {}) {
  switch (mode) {
    case "shadow":
      return { native: "shadow", legacy: "authoritative" };
    case "canary":
      return isCanaryLead(lead, opts.canaryAllowlist) ? { native: "deliver", legacy: "off", canary: true, destinationAllowlist: opts.canaryAllowlist?.destinations } : { native: "none", legacy: "authoritative" };
    case "new_primary_with_legacy_fallback":
      return { native: "deliver", legacy: "fallback" };
    case "new_only":
      return { native: "deliver", legacy: "off" };
    case "legacy_only":
    default:
      return { native: "none", legacy: "authoritative" };
  }
}
function shouldFallback(nativeStatus, approvedFailureCategories = ["no_eligible_member", "rejected", "error_clean"]) {
  const s = String(nativeStatus || "");
  if (s === "accepted" || s === "ambiguous" || s === "duplicate") return false;
  return approvedFailureCategories.includes(s);
}
async function executeMode(mode, lead, ctx) {
  const plan = planExecution(mode, lead, { canaryAllowlist: ctx.canaryAllowlist });
  const out = { mode, plan, native: null, legacy: null };
  if (plan.native === "shadow") {
    out.native = ctx.nativeShadow ? await ctx.nativeShadow(lead) : { status: "traced" };
  } else if (plan.native === "deliver") {
    out.native = await ctx.nativeDeliver(lead);
    if (plan.legacy === "fallback" && shouldFallback(out.native.status, ctx.approvedFailureCategories)) {
      out.legacy = await ctx.legacyDeliver(lead);
    }
  }
  if (plan.legacy === "authoritative") {
    out.legacy = await ctx.legacyDeliver(lead);
  }
  return out;
}
function validateModeTransition(from, to) {
  if (!MODES.includes(to)) return { valid: false, error: "unknown_mode" };
  if (from === to) return { valid: false, error: "no_change" };
  return { valid: true };
}
function buildModeAudit({ from, to, actorId, reason, nowMs }) {
  return {
    action: "mode_change",
    entity_type: "AppSettings",
    entity_id: "distribution_mode",
    from_value: from || "legacy_only",
    to_value: to,
    reason: reason || "",
    actor_id: actorId,
    created_at: new Date(nowMs || 0).toISOString()
  };
}
export {
  ATTEMPT_STATUS,
  BID_REASON,
  CAMPAIGN_MATCH,
  CIRCUIT,
  COMPARE,
  MODES,
  OPERATORS,
  OPERATOR_PERMISSION_KEYS,
  PING_ALLOWLIST,
  REASON,
  RESERVE,
  RUN,
  WALLET,
  _clearActiveGroupCache,
  applyReturnAdjustment,
  applyTransform2 as applyTemplateTransform,
  applyTransform,
  backoffWithJitter,
  buildAttemptRecord,
  buildCaps,
  buildMemberForRetry,
  buildModeAudit,
  buildPayloadFromTemplate,
  buildPingPayload,
  buildRoutingSnapshot,
  buildVersionSnapshot,
  buildWallet,
  capScopeKey,
  capScopesFor,
  capWindowStart,
  classifyResponse,
  compareDecision,
  computeBackoffMs,
  computeBillingLines,
  computeConfigHash,
  deliverDirectPost,
  diffConfig,
  distributeLead,
  escapeJsonString,
  evalConditionTree,
  evalLeaf,
  evaluateMember,
  executeMode,
  exhaustedCap,
  finalize,
  hasActiveRouteGroup,
  idempotencyKey,
  isBlocked,
  isCanaryLead,
  isLeadAlreadySold,
  isOperator,
  isSafeRegexPattern,
  isValidTrustedForm,
  isWithinSchedule,
  loadRoutingSnapshot,
  makeEntityAttemptStore,
  makeEntityCapStore,
  makeEntityHealthStore,
  makeEntityWalletStore,
  makeInMemoryAttemptStore,
  makeInMemoryCasStore,
  makeInMemoryHealthStore,
  makeInMemoryWalletStore,
  manualRetry,
  missingRequiredFields,
  nextHealth,
  nextRetryAtIso,
  orderEligible,
  phoneUs,
  planExecution,
  projectSubDeliveryForClient,
  rankBids,
  redact,
  release,
  reserve,
  reserveAndDeliver,
  resolveCampaign,
  resolvePrice,
  resolveSubDeliveryCfg,
  resolveTemplate,
  resolveTokenValue,
  resolveTraceVersion,
  routeWaterfall,
  runDistribution,
  runPingPost,
  runRetryWorker,
  runShadow,
  runSimulation,
  safeTest,
  selectAuction,
  selectHybrid,
  selectPriority,
  selectRoundRobin,
  selectWeighted,
  sha256Hex,
  shouldFallback,
  shouldRetry,
  summarizeComparisons,
  toClassifyResponseMapping,
  validateConfigForPublish,
  validateModeTransition,
  wallClock,
  walletCredit,
  walletCreditReturn,
  walletDebit
};
