import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
// Uses the shared LLM integration (callLLM).

function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  if (s.startsWith('')) s = s.replace(/^(?:json)?/i, '').replace(/$/i, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return s;
}

// Detect whether an LLM credential is available so we can degrade gracefully
// instead of throwing when nothing is configured.
function llmConfigured(ctx) {
  const i = (ctx.config && ctx.config.integrations) || {};
  const env = ctx.env || {};
  return Boolean(i.openaiApiKey || i.anthropicApiKey || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
}

async function askLLM({ prompt, system, model = 'gpt-4o-mini', temperature = 0.4, jsonSchema = null }) {
  const content = await callLLM({ prompt, system, temperature, maxTokens: 2000 });
  if (jsonSchema) return parseJsonLoose(content);
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Scope a change request into a single-concern build prompt for the CONTROLLED
// channel (Claude via connector, the builder, or Claude Code). Never executes.
// If the message is really an analytics question, returns is_build=false.
async function draftBuildRequest(question, history) {
  const schema = {
    type: 'object',
    properties: {
      is_build: { type: 'boolean' },
      title: { type: 'string' },
      summary: { type: 'string' },
      target_files: { type: 'array', items: { type: 'string' } },
      do_not_touch: { type: 'array', items: { type: 'string' } },
      risk: { type: 'string', enum: ['green', 'amber', 'red'] },
      ready_prompt: { type: 'string' },
    },
    required: ['is_build', 'title', 'summary', 'ready_prompt'],
  };
  const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'DataBot'}: ${m.content}`).join('\n');
  const system = `You scope change requests for the Legenex app so they can be handed to a controlled build channel (Claude via the connector, the builder, or Claude Code). You NEVER execute changes yourself. If the user's message is actually an analytics or data question rather than a request to change the app, set is_build=false and leave the other fields empty.\n\nBake these conventions into ready_prompt so it is safe to run:\n- One concern per change, with an explicit do-not-touch list.\n- Follow DESIGN-SYSTEM.md: semantic tokens only, never raw hex/hsl or raw palette utilities.\n- RED surfaces that need explicit human approval and must not be edited casually: processLead, the four LeadByteConnectors and their enabled states, Conversion Events, distribution_mode (only via distributionSetMode), credentials, live endpoints, billing records, buyer pricing and state coverage.\n- Additive schema only. No em dashes anywhere. Checkpoint before any schema or destructive change. Verify with the design-token gate and lint.\n\nready_prompt must be a complete, copy-pasteable instruction a builder can act on: the target area, the exact change, the do-not-touch list, and the verification step. Set risk=red if the request touches any RED surface, amber if it touches shared or data surfaces, green for isolated UI or docs.`;
  const prompt = `Conversation so far:\n${convo || '(none)'}\n\nUser request: ${question}\n\nReturn a single JSON object only, with keys: is_build (boolean), title (string), summary (string), target_files (string array), do_not_touch (string array), risk ("green"|"amber"|"red"), ready_prompt (string). Required: is_build, title, summary, ready_prompt.`;
  return await askLLM({ system, prompt, jsonSchema: schema, temperature: 0.2 });
}

export default async function dataBot(ctx) {
  const user = requireUser(ctx);
  try {
    const db = ctx.db;

    const body = ctx.body || {};
    const question = (body.question || '').toString().trim();
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    if (!question) return ctx.json({ error: 'No question provided' }, 400);

    const isAdmin = user.role === 'admin';
    const mode = body.mode === 'build' ? 'build' : 'data';

    // Friendly, actionable message instead of a silent 500 when no key is configured.
    if (!llmConfigured(ctx)) {
      return ctx.json({ type: 'answer', answer: 'This assistant is not configured yet: no LLM API key is set. An admin can add it in the app secrets, then I can answer.' });
    }

    // BuildBot: draft a single-concern build request for the controlled channel.
    // Operator-gated for now; a grantable buildbot permission comes next.
    if (mode === 'build') {
      if (!isAdmin) {
        return ctx.json({ type: 'answer', answer: 'BuildBot is available to admins and owners only.' });
      }
      try {
        const draft = await draftBuildRequest(question, history);
        if (draft && draft.is_build) return ctx.json({ type: 'build_request', build_request: draft });
      } catch (_) { /* not a build, or draft failed: fall through to an answer */ }
    }

    // --- Resolve caller scope (deny-by-default), then gather only what they may see ---
    let scope = { kind: 'none', id: null };
    if (isAdmin) scope = { kind: 'operator', id: null };
    else if (user.base_role === 'supplier' || user.linked_supplier_id) scope = { kind: 'supplier', id: user.linked_supplier_id || null };
    else if (user.base_role === 'buyer' || user.linked_buyer_id) scope = { kind: 'buyer', id: user.linked_buyer_id || null };

    const sum = (a, f) => a.reduce((acc, x) => acc + (Number(f(x)) || 0), 0);
    const statusMap = (rows) => { const m = {}; for (const l of rows) m[l.final_status] = (m[l.final_status] || 0) + 1; return m; };

    let dataSummary = {};
    let kbContext = '';
    let scopeNote = '';

    if (scope.kind === 'operator') {
      const [leads, suppliers, buyers, adSpend, txns, kbDocs] = await Promise.all([
        db.entities.Lead.list('-created_date', 500).catch(() => []),
        db.entities.Supplier.list().catch(() => []),
        db.entities.Buyer.list().catch(() => []),
        db.entities.AdSpend.list('-date', 500).catch(() => []),
        db.entities.BankTransaction.list('-date', 300).catch(() => []),
        db.entities.KnowledgeDoc.filter({ active: true }, 'sort_order').catch(() => []),
      ]);
      dataSummary = {
        leads_total: leads.length,
        leads_by_status: statusMap(leads),
        revenue_total: Math.round(sum(leads, (l) => l.revenue)),
        suppliers_count: suppliers.length,
        supplier_names: suppliers.slice(0, 40).map((s) => s.name),
        buyers_count: buyers.length,
        buyer_names: buyers.slice(0, 40).map((b) => b.company_name),
        ad_spend_total: Math.round(sum(adSpend, (a) => a.spend)),
        ad_spend_by_supplier: (() => { const m = {}; for (const r of adSpend) { if (r.level && r.level !== 'account') continue; const k = r.supplier_name || '(unattributed)'; m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100; } return m; })(),
        ad_spend_by_account: (() => { const m = {}; for (const r of adSpend) { if (r.level && r.level !== 'account') continue; const k = r.cost_source || r.ad_account_id || '(unknown account)'; m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100; } return m; })(),
        ad_spend_by_month: (() => { const m = {}; for (const r of adSpend) { if (r.level && r.level !== 'account') continue; const k = String(r.date || '').slice(0, 7); if (!k) continue; m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100; } return m; })(),
        ad_spend_date_range: (() => { const ds = adSpend.map((r) => r.date).filter(Boolean).sort(); return ds.length ? { earliest: ds[0], latest: ds[ds.length - 1], days: ds.length } : null; })(),
        ad_spend_recent_days: adSpend.filter((r) => !r.level || r.level === 'account').slice(0, 45).map((r) => ({ date: r.date, spend: Number(r.spend) || 0, supplier: r.supplier_name || '', account: r.cost_source || r.ad_account_id || '', platform: r.platform || '', vertical: r.vertical || '' })),
        bank_money_in: Math.round(sum(txns.filter((t) => t.amount > 0), (t) => t.amount)),
        bank_money_out: Math.round(sum(txns.filter((t) => t.amount < 0), (t) => t.amount)),
        bank_unmatched: txns.filter((t) => !t.reconciled).length,
        recent_leads: leads.slice(0, 25).map((l) => ({ supplier: l.supplier_name, status: l.final_status, revenue: l.revenue, email_valid: l.email_valid, created: l.created_date })),
      };
      kbContext = kbDocs.map((d) => { const head = d.kind === 'glossary' ? `${d.term || d.title}` : d.title; return `[${d.kind}] ${head}: ${d.content || ''}`; }).join('\n');
    } else if (scope.kind === 'supplier') {
      const supplier = scope.id ? await db.entities.Supplier.get(scope.id).catch(() => null) : null;
      if (!supplier) { scope = { kind: 'none', id: null }; }
      else {
        const leads = await db.entities.Lead.filter({ supplier_name: supplier.name }, '-created_date', 3000).catch(() => []);
        const leadIds = new Set(leads.map((l) => l.id));
        let returnsTotal = 0;
        try { const rr = await db.entities.ReturnRequest.list('-created_date', 3000); returnsTotal = rr.filter((r) => leadIds.has(r.lead_id)).length; } catch { returnsTotal = 0; }
        scopeNote = `You are answering for supplier "${supplier.name}". Only this supplier's own lead volume and quality are available. Buyer identities, revenue, internal cost, and other suppliers' data are NOT available and must never be inferred or disclosed.`;
        dataSummary = {
          account_type: 'supplier',
          supplier_name: supplier.name,
          vertical: supplier.vertical || null,
          leads_total: leads.length,
          leads_by_status: statusMap(leads),
          returns_total: returnsTotal,
          recent_leads: leads.slice(0, 25).map((l) => ({ status: l.final_status, response_reason: l.response_reason || '', created: l.created_date })),
        };
      }
    } else if (scope.kind === 'buyer') {
      const buyer = scope.id ? await db.entities.Buyer.get(scope.id).catch(() => null) : null;
      if (!buyer) { scope = { kind: 'none', id: null }; }
      else {
        const [leads, feedback, returns] = await Promise.all([
          db.entities.Lead.filter({ buyer_id: buyer.id }, '-created_date', 2000).catch(() => []),
          db.entities.BuyerFeedback.filter({ buyer_id: buyer.id }, '-created_date', 2000).catch(() => []),
          db.entities.ReturnRequest.filter({ buyer_id: buyer.id }, '-created_date', 2000).catch(() => []),
        ]);
        scopeNote = `You are answering for buyer "${buyer.company_name || buyer.name || 'this buyer'}". Only this buyer's own received leads, feedback, and returns are available. Other buyers' and any supplier's data are NOT available and must never be inferred or disclosed.`;
        dataSummary = {
          account_type: 'buyer',
          buyer_name: buyer.company_name || buyer.name || null,
          leads_received: leads.length,
          leads_by_status: statusMap(leads),
          feedback_total: feedback.length,
          returns_total: returns.length,
          recent_leads: leads.slice(0, 25).map((l) => ({ status: l.final_status, created: l.created_date })),
        };
      }
    }

    if (scope.kind === 'none') {
      scopeNote = 'No account is linked to this user, so there is no account data to show. Do not invent data; answer only general questions.';
      dataSummary = {};
    }

    const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'DataBot'}: ${m.content}`).join('\n');

    const prompt = `You are DataBot, an analytics assistant embedded in the Legenex lead-management platform.
Answer the user's question using ONLY the data and knowledge base below. Be concise, specific, and use numbers from the data. If the data does not contain the answer, say so plainly.
${scopeNote ? `SCOPE (strict): ${scopeNote}\n` : ''}When asked where a figure comes from, trace it through any ad_spend breakdowns present and name the date, supplier and account; a number that does not match a total may match a single day. If ad_spend_date_range shows the latest date is well before today, say the spend looks stale and give that date.

=== ACCOUNT DATA (JSON) ===
${JSON.stringify(dataSummary)}

=== KNOWLEDGE BASE ===
${kbContext || '(none available for this account)'}

=== CONVERSATION SO FAR ===
${convo || '(none)'}

User: ${question}
DataBot:`;

    const answer = await askLLM({ prompt });

    return ctx.json({ type: 'answer', answer: typeof answer === 'string' ? answer : JSON.stringify(answer) });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
