import { requireUser, HttpError } from './_runtime.js';
import { callLLM, invokeLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
// Remembers past conversations and learns facts from each exchange.

const NOT_CONFIGURED_MSG =
  'This assistant is not configured yet: the language model is not available. An admin can add the LLM credentials in the app settings, then I can answer.';

function isConfigError(e) {
  const m = (e && e.message ? e.message : String(e || '')).toLowerCase();
  return (
    m.includes('not configured') ||
    m.includes('not set') ||
    m.includes('api key') ||
    m.includes('apikey') ||
    m.includes('no llm') ||
    m.includes('missing')
  );
}

// Structured-output call: fold system into the prompt and request a JSON schema.
async function askJson({ system, prompt, temperature = 0.4, jsonSchema }) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const result = await invokeLLM({ prompt: fullPrompt, response_json_schema: jsonSchema, temperature });
  if (result && typeof result === 'object') return result;
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return result; }
  }
  return result;
}

// Free-text call.
async function askText({ system, prompt, temperature = 0.4 }) {
  const out = await callLLM({ prompt, system, temperature });
  if (typeof out === 'string') return out;
  return out?.content ?? out?.text ?? String(out ?? '');
}

// Scope a change request into a single-concern build prompt for the CONTROLLED
// channel (Claude via connector, the app builder, or Claude Code). Never executes.
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
  const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'BuildBot'}: ${m.content}`).join('\n');
  const system = `You scope change requests for the Legenex app so they can be handed to a controlled build channel (Claude via the app connector, the app builder, or Claude Code). You NEVER execute changes yourself. If the user's message is actually an analytics or data question rather than a request to change the app, set is_build=false and leave the other fields empty.\n\nBake these conventions into ready_prompt so it is safe to run:\n- One concern per change, with an explicit do-not-touch list.\n- Follow DESIGN-SYSTEM.md: semantic tokens only, never raw hex/hsl or raw palette utilities.\n- RED surfaces that need explicit human approval and must not be edited casually: processLead, the four LeadByteConnectors and their enabled states, Conversion Events, distribution_mode (only via distributionSetMode), credentials, live endpoints, billing records, buyer pricing and state coverage.\n- Additive schema only. No em dashes anywhere. Checkpoint before any schema or destructive change. Verify with the design-token gate and lint.\n\nready_prompt must be a complete, copy-pasteable instruction a builder can act on: the target area, the exact change, the do-not-touch list, and the verification step. Set risk=red if the request touches any RED surface, amber if it touches shared or data surfaces, green for isolated UI or docs.`;
  const prompt = `Conversation so far:\n${convo || '(none)'}\n\nUser request: ${question}\n\nReturn JSON only.`;
  return await askJson({ system, prompt, jsonSchema: schema, temperature: 0.2 });
}

// Extract learnable facts from a conversation exchange. Returns up to 3 facts.
async function extractMemories(question, answer, existingMemory) {
  const schema = {
    type: 'object',
    properties: {
      memories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'A concise, durable fact or preference learned from this exchange' },
            category: { type: 'string', enum: ['preference', 'business_rule', 'data_insight', 'definition', 'other'] },
          },
          required: ['fact', 'category'],
        },
      },
    },
    required: ['memories'],
  };
  const existingStr = existingMemory.slice(0, 20).map((m) => `- ${m.fact}`).join('\n');
  const system = `You extract durable, reusable facts and preferences from a conversation between a user and an analytics assistant. Only extract facts that will be useful in future conversations: business rules, user preferences, recurring data insights, or definitions the user provided. Do NOT extract transient questions or answers. Do NOT duplicate facts already known.\n\nKnown memories:\n${existingStr || '(none)'}`;
  const prompt = `User asked: ${question}\nAssistant answered: ${answer}\n\nExtract up to 3 new memories. Return JSON only.`;
  try {
    const result = await askJson({ system, prompt, jsonSchema: schema, temperature: 0.2 });
    return Array.isArray(result?.memories) ? result.memories.filter((m) => m.fact && m.fact.length > 5).slice(0, 3) : [];
  } catch { return []; }
}

export default async function dataBot(ctx) {
  const user = requireUser(ctx);
  try {
    const db = ctx.db;

    const body = ctx.body || {};
    const question = (body.question || '').toString().trim();
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    if (!question) return ctx.json({ error: 'No question provided' }, 400);

    const isAdmin = user.role === 'admin' || user.role === 'owner';
    const mode = body.mode === 'build' ? 'build' : 'data';

    // Resolve DataBot/BuildBot access from the permission model: explicit perms
    // when the user has any stored, otherwise the role default. Owner always
    // has all permissions (mirrors the frontend usePermissions hook).
    const resolvePerms = (u) => {
      if (u.role === 'owner') return { databot: true, buildbot: true };
      let p = {};
      try { p = u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) : {}; } catch { p = {}; }
      if (p && Object.keys(p).length) return p;
      return { databot: true, buildbot: u.role === 'owner' || u.role === 'admin' };
    };
    const isPartner = user.base_role === 'supplier' || user.base_role === 'buyer' || !!user.linked_supplier_id || !!user.linked_buyer_id;
    const perms = resolvePerms(user);
    const canData = !!perms.databot;
    const canBuild = !isPartner && !!perms.buildbot;

    // BuildBot: draft a single-concern build request for the controlled channel.
    if (mode === 'build') {
      if (!canBuild) {
        return { type: 'answer', answer: 'BuildBot is not enabled for your account. An admin can grant the BuildBot permission in Users and Roles.' };
      }
      try {
        const draft = await draftBuildRequest(question, history);
        if (draft && draft.is_build) return { type: 'build_request', build_request: draft };
      } catch (e) {
        if (isConfigError(e)) return { type: 'answer', answer: NOT_CONFIGURED_MSG };
        /* not a build, or draft failed: fall through to an answer */
      }
    }

    if (!canData) {
      return { type: 'answer', answer: 'DataBot access is turned off for your account. An admin can enable it in Users and Roles.' };
    }

    // --- Load conversation history and memories for context ---
    let pastConversations = [];
    let memories = [];
    let conversationId = body.conversation_id || null;

    try {
      // Load recent active memories (learned facts) for this user.
      memories = await db.entities.ChatMemory.filter(
        { user_id: user.id, active: true },
        '-created_date', 30
      ).catch(() => []);
      // Load recent conversations for continuity (titles + last few messages).
      const recentConvs = await db.entities.ChatConversation.filter(
        { user_id: user.id, mode, active: true },
        '-last_message_at', 5
      ).catch(() => []);
      pastConversations = recentConvs.map((c) => {
        let msgs = [];
        try { msgs = JSON.parse(c.messages || '[]'); } catch {}
        const lastMsgs = msgs.slice(-4);
        return { title: c.title, recent: lastMsgs.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`) };
      });
    } catch { /* memory entities may not exist yet */ }

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

    const convo = history.map((m) => `${m.role === 'user' ? 'User' : (mode === 'build' ? 'BuildBot' : 'DataBot')}: ${m.content}`).join('\n');

    // Format memories for context
    const memoryContext = memories.length
      ? memories.map((m) => `- [${m.category}] ${m.fact}`).join('\n')
      : '(none yet)';

    // Format past conversations for continuity
    const pastConvContext = pastConversations.length
      ? pastConversations.map((c) => `Conversation "${c.title}":\n${c.recent.join('\n')}`).join('\n\n')
      : '(none)';

    const botName = mode === 'build' ? 'BuildBot' : 'DataBot';
    const prompt = `You are ${botName}, an analytics assistant embedded in the Legenex lead-management platform.
Answer the user's question using ONLY the data and knowledge base below. Be concise, specific, and use numbers from the data. If the data does not contain the answer, say so plainly.
${scopeNote ? `SCOPE (strict): ${scopeNote}\n` : ''}When asked where a figure comes from, trace it through any ad_spend breakdowns present and name the date, supplier and account; a number that does not match a total may match a single day. If ad_spend_date_range shows the latest date is well before today, say the spend looks stale and give that date.

=== LEARNED MEMORIES (facts you've learned from past conversations) ===
${memoryContext}

=== RECENT CONVERSATIONS (for continuity) ===
${pastConvContext}

=== ACCOUNT DATA (JSON) ===
${JSON.stringify(dataSummary)}

=== KNOWLEDGE BASE ===
${kbContext || '(none available for this account)'}

=== CONVERSATION SO FAR ===
${convo || '(none)'}

User: ${question}
${botName}:`;

    let answer;
    try {
      answer = await askText({ prompt });
    } catch (e) {
      if (isConfigError(e)) return { type: 'answer', answer: NOT_CONFIGURED_MSG };
      throw e;
    }

    const answerStr = typeof answer === 'string' ? answer : JSON.stringify(answer);

    // --- Persist the conversation and extract memories (best-effort) ---
    try {
      const now = new Date().toISOString();
      // Find or create a conversation for this user + mode
      let conv = null;
      if (conversationId) {
        conv = await db.entities.ChatConversation.get(conversationId).catch(() => null);
      }
      if (!conv) {
        // Try to find the most recent active conversation for this user+mode
        const recent = await db.entities.ChatConversation.filter(
          { user_id: user.id, mode, active: true },
          '-last_message_at', 1
        ).catch(() => []);
        if (recent.length) conv = recent[0];
      }
      const allHistory = [...history, { role: 'assistant', content: answerStr, timestamp: now }];
      if (conv) {
        let existingMsgs = [];
        try { existingMsgs = JSON.parse(conv.messages || '[]'); } catch {}
        // Replace the last N messages with the updated history
        const updatedMsgs = [...existingMsgs.slice(0, -history.length), ...allHistory];
        await db.entities.ChatConversation.update(conv.id, {
          messages: JSON.stringify(updatedMsgs.slice(-50)),
          message_count: (conv.message_count || 0) + 2,
          last_message_at: now,
          title: conv.title || question.slice(0, 80),
        });
        conversationId = conv.id;
      } else {
        const created = await db.entities.ChatConversation.create({
          user_id: user.id,
          mode,
          title: question.slice(0, 80),
          messages: JSON.stringify(allHistory.slice(-50)),
          message_count: allHistory.length,
          last_message_at: now,
        });
        conversationId = created.id;
      }

      // Extract and persist memories from this exchange (best-effort)
      const newMemories = await extractMemories(question, answerStr, memories);
      for (const mem of newMemories) {
        await db.entities.ChatMemory.create({
          user_id: user.id,
          fact: mem.fact,
          category: mem.category || 'other',
          source_conversation_id: conversationId,
          confidence: 3,
        }).catch(() => {});
      }
    } catch { /* conversation persistence is best-effort */ }

    return { type: 'answer', answer: answerStr, conversation_id: conversationId };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
