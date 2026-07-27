import { requireUser, HttpError } from './_runtime.js';
import { callLLM, invokeLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.

// Scope a change request into a single-concern build prompt for the CONTROLLED
// channel. Never executes. If the message is really an analytics question,
// returns is_build=false.
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
  const system = `You scope change requests for the Legenex app so they can be handed to a controlled build channel. You NEVER execute changes yourself. If the user's message is actually an analytics or data question rather than a request to change the app, set is_build=false and leave the other fields empty.\n\nBake these conventions into ready_prompt so it is safe to run:\n- One concern per change, with an explicit do-not-touch list.\n- Follow DESIGN-SYSTEM.md: semantic tokens only, never raw hex/hsl or raw palette utilities.\n- RED surfaces that need explicit human approval and must not be edited casually: processLead, the four LeadByteConnectors and their enabled states, Conversion Events, distribution_mode (only via distributionSetMode), credentials, live endpoints, billing records, buyer pricing and state coverage.\n- Additive schema only. No em dashes anywhere. Checkpoint before any schema or destructive change. Verify with the design-token gate and lint.\n\nready_prompt must be a complete, copy-pasteable instruction a builder can act on: the target area, the exact change, the do-not-touch list, and the verification step. Set risk=red if the request touches any RED surface, amber if it touches shared or data surfaces, green for isolated UI or docs.`;
  const prompt = `Conversation so far:\n${convo || '(none)'}\n\nUser request: ${question}\n\nReturn JSON only.`;
  return await invokeLLM({ system, prompt, temperature: 0.2, response_json_schema: schema });
}

export default async function dataBot(ctx) {
  try {
    const db = ctx.db;
    const user = requireUser(ctx);

    const body = ctx.body || {};
    const question = (body.question || '').toString().trim();
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    if (!question) return ctx.json({ error: 'No question provided' }, 400);

    const isAdmin = user.role === 'admin';
    const mode = body.mode === 'build' ? 'build' : 'data';

    // Resolve DataBot/BuildBot access from the permission model: explicit perms
    // when the user has any stored, otherwise the role default. Partners (supplier
    // or buyer) can never build, matching RESTRICTED_FOR_PARTNERS.
    const resolvePerms = (u) => {
      let p = {};
      try { p = u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) : {}; } catch { p = {}; }
      if (p && Object.keys(p).length) return p;
      return { databot: true, buildbot: u.role === 'owner' || u.role === 'admin' };
    };
    const isPartner = user.base_role === 'supplier' || user.base_role === 'buyer' || !!user.linked_supplier_id || !!user.linked_buyer_id;
    const perms = resolvePerms(user);
    const canData = !!perms.databot;
    const canBuild = !isPartner && !!perms.buildbot;
    void isAdmin;

    // Friendly, actionable message instead of a silent 500 when the key is unset.
    if (!(ctx.config?.integrations?.openaiApiKey || ctx.env?.OPENAI_API_KEY)) {
      return ctx.json({ type: 'answer', answer: 'This assistant is not configured yet: the OPENAI_API_KEY secret is missing. An admin can add it in the app secrets, then I can answer.' });
    }

    // BuildBot: draft a single-concern build request for the controlled channel.
    // Gated by the buildbot permission (owner/admin by default, grantable in Users and Roles).
    if (mode === 'build') {
      if (!canBuild) {
        return ctx.json({ type: 'answer', answer: 'BuildBot is not enabled for your account. An admin can grant the BuildBot permission in Users and Roles.' });
      }
      try {
        const draft = await draftBuildRequest(question, history);
        if (draft && draft.is_build) return ctx.json({ type: 'build_request', build_request: draft });
      } catch (_) { /* not a build, or draft failed: fall through to an answer */ }
    }

    if (!canData) {
      return ctx.json({ type: 'answer', answer: 'DataBot access is turned off for your account. An admin can enable it in Users and Roles.' });
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

    const answer = await callLLM({ prompt, temperature: 0.4 });

    return ctx.json({ type: 'answer', answer: typeof answer === 'string' ? answer : JSON.stringify(answer) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
