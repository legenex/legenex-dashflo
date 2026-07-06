import { invokeLLM } from '../integrations/llm.js';

// Public buyer feedback webhook (/functions/buyerFeedbackWebhook).
// Buyers POST feedback here. We authenticate with a per-buyer feedback token,
// match the lead by phone or email, AI-map the buyer's raw disposition to our
// taxonomy, and persist a BuyerFeedback record (source = webhook).

const TAXONOMY = [
  'At Fault', 'Attorney Rejected', 'Already Settled', 'Chase', 'Converted', 'Denied',
  'Do Not Call', 'Duplicate', 'Faux Lead', 'Has Attorney', 'Lost Contact', 'Minor',
  'No Damages', 'New Lead', 'No Contact', 'No Injury', 'No Insurance', 'No Liability',
  'No Treatment', 'Not Interested', 'Other', 'Past SOL', 'Referred', 'Wrong Law Type', 'Wrong Number',
];

function normPhone(v) {
  return String(v || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}
function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

async function mapDisposition(raw) {
  const exact = TAXONOMY.find(t => t.toLowerCase() === String(raw || '').trim().toLowerCase());
  if (exact) return { disposition: exact, confidence: 1 };

  // No raw disposition or no LLM configured -> degrade gracefully.
  if (!raw) return { disposition: 'Other', confidence: 0.3 };

  try {
    const parsed = await invokeLLM({
      prompt: `Map the buyer's raw lead disposition to the single closest value in this fixed taxonomy. Reply ONLY with JSON {"disposition": "<one taxonomy value>", "confidence": <0-1>}. If nothing fits, use "Other".

Taxonomy: ${TAXONOMY.join(', ')}

Buyer's raw disposition: "${raw}"`,
      temperature: 0,
      response_json_schema: {
        type: 'object',
        properties: {
          disposition: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['disposition', 'confidence'],
      },
    });
    const disposition = TAXONOMY.includes(parsed?.disposition) ? parsed.disposition : 'Other';
    let confidence = Number(parsed?.confidence);
    if (isNaN(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    return { disposition, confidence };
  } catch {
    return { disposition: 'Other', confidence: 0.3 };
  }
}

export default async function buyerFeedbackWebhook(ctx) {
  const method = ctx.req.method;
  if (method === 'OPTIONS') return ctx.json(null, 204);
  if (method === 'GET') return ctx.json({ status: 'ok' }, 200);
  if (method !== 'POST') return ctx.json({ error: 'Method not allowed' }, 405);

  try {
    const db = ctx.db;
    const body = ctx.body || {};

    // Authenticate the buyer by their feedback token (buyer id used as token).
    let token = ctx.req.get('X-BUYER-TOKEN') || body.buyer_token || '';
    if (!token) {
      const auth = ctx.req.get('Authorization') || '';
      if (auth.startsWith('Bearer ')) token = auth.slice(7);
    }
    if (!token) return ctx.json({ error: 'Missing buyer token' }, 401);

    let buyer = null;
    try { buyer = await db.entities.Buyer.get(token); } catch { buyer = null; }
    if (!buyer || !buyer.portal_enabled) {
      return ctx.json({ error: 'Invalid buyer token or portal disabled' }, 401);
    }

    const phone = normPhone(body.phone || body.mobile);
    const email = normEmail(body.email);
    if (!phone && !email) {
      return ctx.json({ error: 'Provide phone or email to match the lead' }, 400);
    }

    // Match a lead by phone or email (search a recent window).
    let matchedLead = null;
    let matchedBy = '';
    const recent = await db.entities.Lead.list('-created_date', 5000);
    for (const l of recent) {
      if (phone && normPhone(l.mobile) && normPhone(l.mobile) === phone) { matchedLead = l; matchedBy = 'phone'; break; }
    }
    if (!matchedLead && email) {
      for (const l of recent) {
        if (email && normEmail(l.email) === email) { matchedLead = l; matchedBy = 'email'; break; }
      }
    }

    const rawDisposition = String(body.disposition || body.raw_disposition || '').trim();
    const { disposition, confidence } = await mapDisposition(rawDisposition);

    const feedback = await db.entities.BuyerFeedback.create({
      lead_id: matchedLead?.id || null,
      buyer_id: buyer.id,
      matched_by: matchedBy,
      disposition,
      raw_disposition: rawDisposition,
      notes: String(body.notes || ''),
      outcome: String(body.outcome || ''),
      revenue_value: Number(body.revenue_value) || 0,
      source: 'webhook',
      match_confidence: confidence,
    });

    // Stamp the mapped disposition + buyer onto the matched lead for reporting.
    if (matchedLead) {
      await db.entities.Lead.update(matchedLead.id, {
        buyer_feedback: disposition,
        buyer_id: matchedLead.buyer_id || buyer.id,
      });
    }

    return ctx.json({
      status: 'ok',
      matched: !!matchedLead,
      matched_by: matchedBy || null,
      disposition,
      match_confidence: confidence,
      feedback_id: feedback.id,
    }, 200);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
