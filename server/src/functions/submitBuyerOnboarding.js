import { sendMail } from '../lib/mailer.js';

// Public buyer onboarding intake (/functions/submitBuyerOnboarding).
// Unauthenticated. It validates the submission, rate limits by IP, dedupes on
// company_name + email within ten minutes, and writes exactly one
// BuyerOnboarding record.
//
// This function ONLY records the submission. It does not create a Buyer, does
// not allocate a buyer_code, and never contacts Stripe, Xero, LeadByte, GHL or
// Rebrandly.

// Fifty states plus DC. This is the authoritative server side allow list, so
// the client can never widen it.
const VALID_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

const VALID_CLIENT_TYPES = new Set(['Law Firm', 'Aggregator', 'Reseller', 'Network']);
const VALID_BILLING_TYPES = new Set(['prepay', 'invoiced_daily', 'invoiced_weekly', 'invoiced_monthly']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In memory IP rate limiter. Per warm instance, best effort. A short window is
// enough to blunt bursts without a persistent store.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;
const ipHits = new Map();

function clientIp(req) {
  const headers = (req && req.headers) || {};
  const fwd = headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return headers['x-real-ip'] || (req && req.ip) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > RATE_MAX;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

export default async function submitBuyerOnboarding(ctx) {
  const method = ctx.req && ctx.req.method;
  if (method === 'OPTIONS') return ctx.json({}, 204);
  if (method === 'GET') return ctx.json({ status: 'ok' }, 200);
  if (method && method !== 'POST') return ctx.json({ error: 'Method not allowed' }, 405);

  try {
    const db = ctx.db;
    const ip = clientIp(ctx.req);
    if (rateLimited(ip)) {
      return ctx.json(
        { error: 'Too many submissions from this network. Please wait a moment and try again.' },
        429,
      );
    }

    const body = ctx.body || {};
    const token = str(body.token);

    // ── Server side validation. Never trust the client. ──────────────────
    const fieldErrors = {};

    const companyName = str(body.company_name);
    if (!companyName) fieldErrors.company_name = 'Company name is required.';

    const primaryContactName = str(body.primary_contact_name);
    if (!primaryContactName) fieldErrors.primary_contact_name = 'Primary contact name is required.';

    const primaryContactEmail = str(body.primary_contact_email).toLowerCase();
    if (!primaryContactEmail) fieldErrors.primary_contact_email = 'Primary contact email is required.';
    else if (!EMAIL_RE.test(primaryContactEmail)) fieldErrors.primary_contact_email = 'Enter a valid email address.';

    const primaryContactPhone = str(body.primary_contact_phone);
    if (!primaryContactPhone) fieldErrors.primary_contact_phone = 'Primary contact phone is required.';

    // Target states: array of two letter codes, all within the allow list.
    const rawStates = Array.isArray(body.target_states) ? body.target_states : [];
    const targetStates = rawStates.map((s) => str(s).toUpperCase()).filter(Boolean);
    if (targetStates.length === 0) {
      fieldErrors.target_states = 'Select at least one target state.';
    } else {
      const invalid = targetStates.filter((s) => !VALID_STATES.has(s));
      if (invalid.length > 0) {
        fieldErrors.target_states = `Not valid US state codes: ${invalid.join(', ')}.`;
      }
    }

    const clientType = str(body.client_type);
    if (!clientType) fieldErrors.client_type = 'Client type is required.';
    else if (!VALID_CLIENT_TYPES.has(clientType)) fieldErrors.client_type = 'Choose a valid client type.';

    const cplRaw = body.cpl;
    const cpl = Number(cplRaw);
    if (cplRaw === '' || cplRaw == null || Number.isNaN(cpl)) fieldErrors.cpl = 'CPL is required and must be a number.';
    else if (cpl < 0) fieldErrors.cpl = 'CPL cannot be negative.';

    const billingType = str(body.billing_type);
    if (!billingType) fieldErrors.billing_type = 'Billing type is required.';
    else if (!VALID_BILLING_TYPES.has(billingType)) fieldErrors.billing_type = 'Choose a valid billing type.';

    if (Object.keys(fieldErrors).length > 0) {
      return ctx.json(
        { error: 'Some fields need attention.', field_errors: fieldErrors },
        400,
      );
    }

    // Token flow: a buyer-first onboarding link. Update the existing invited
    // record for this buyer instead of creating a new submission. buyer_id is
    // already set on that record, so the submission stays tied to the buyer.
    if (token) {
      const list = await db.entities.BuyerOnboarding.filter({ token });
      const rec = (Array.isArray(list) ? list : [])[0];
      if (!rec) {
        return ctx.json({ error: 'Invalid or expired onboarding link.' }, 404);
      }
      if (rec.status === 'cancelled') {
        return ctx.json({ error: 'This onboarding link is no longer active.' }, 410);
      }
      if (rec.status === 'complete') {
        return ctx.json({ status: 'duplicate', onboarding_id: rec.id, company_name: rec.company_name }, 200);
      }
      const wasInvited = rec.status === 'invited';
      const patch = {
        form_payload: JSON.stringify(body),
        submitted_at: new Date().toISOString(),
      };
      if (wasInvited) patch.status = 'submitted';
      await db.entities.BuyerOnboarding.update(rec.id, patch);

      if (wasInvited) {
        try {
          const tplList = await db.entities.OnboardingEmailTemplate.filter({ event: 'submitted' });
          const tpl = (Array.isArray(tplList) ? tplList : [])[0] || null;
          if (tpl && tpl.enabled !== false) {
            const buyer = rec.buyer_id ? await db.entities.Buyer.get(rec.buyer_id).catch(() => null) : null;
            const to = str(body.primary_contact_email) || (buyer && buyer.email) || '';
            if (to) {
              const vars = {
                company_name: (buyer && buyer.company_name) || rec.company_name || str(body.company_name) || '',
                contact_name: str(body.primary_contact_name) || 'there',
                buyer_code: (buyer && buyer.buyer_code) || '',
                vertical: (buyer && buyer.vertical) || str(body.vertical) || '',
              };
              const renderTpl = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k]) : ''));
              await sendMail({ to, subject: renderTpl(tpl.subject), text: renderTpl(tpl.body) });
            }
          }
        } catch (_e) {
          // Non-fatal: the submission still succeeds even if the email fails.
        }
      }

      return ctx.json({ status: 'ok', onboarding_id: rec.id, company_name: rec.company_name }, 200);
    }

    // ── Duplicate guard: same company_name + email within ten minutes. ────
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const recent = await db.entities.BuyerOnboarding.filter(
      { company_name: companyName },
      '-created_date',
      50,
    );
    const existing = (Array.isArray(recent) ? recent : []).find((r) => {
      let payloadEmail = '';
      try {
        const p = typeof r.form_payload === 'string' ? JSON.parse(r.form_payload) : (r.form_payload || {});
        payloadEmail = str(p && p.primary_contact_email).toLowerCase();
      } catch { payloadEmail = ''; }
      const submittedMs = r.submitted_at ? new Date(r.submitted_at).getTime()
        : (r.created_date ? new Date(r.created_date).getTime() : 0);
      return payloadEmail === primaryContactEmail && submittedMs >= tenMinutesAgo;
    });

    if (existing) {
      return ctx.json(
        { status: 'duplicate', onboarding_id: existing.id, company_name: existing.company_name },
        200,
      );
    }

    // ── Persist the complete raw submission. buyer_id null, steps empty. ──
    const now = new Date().toISOString();
    const record = await db.entities.BuyerOnboarding.create({
      buyer_id: null,
      company_name: companyName,
      status: 'submitted',
      form_payload: JSON.stringify(body),
      steps: '[]',
      current_step: null,
      submitted_at: now,
    });

    return ctx.json(
      { status: 'ok', onboarding_id: record.id, company_name: record.company_name },
      200,
    );
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
