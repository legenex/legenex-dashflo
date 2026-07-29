import { requireUser, HttpError } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
// Uses the shared LLM integration. Remembers past conversations and learns facts
// from each exchange.

// Extract a JSON value from a model response that may be fenced or padded with prose.
function parseJsonLoose(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').trim();
  const unfenced = s.replace(/^(?:json)?\s*/i, '').replace(/\s*$/, '').trim();
  try { return JSON.parse(unfenced); } catch {}
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch {}
  }
  return unfenced;
}

async function callText({ prompt, system, temperature = 0.4 }) {
  const out = await callLLM({ prompt, system, temperature });
  if (typeof out === 'string') return out;
  return out?.content ?? out?.text ?? out?.answer ?? String(out ?? '');
}

async function callJson({ prompt, system, temperature = 0.2 }) {
  const raw = await callText({ prompt, system, temperature });
  return parseJsonLoose(raw);
}

// Scope a change request into a single-concern build prompt for the CONTROLLED
// channel (Claude via connector, the builder, or Claude Code). Never executes.
async function draftBuildRequest(question, history) {
  const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'BuildBot'}: ${m.content}`).join('\n');
  const system = `You scope change requests for the Legenex app so they can be handed to a controlled build channel (Claude via the connector, the builder, or Claude Code). You NEVER execute changes yourself. If the user's message is actually an analytics or data question rather than a request to change the app, set is_build=false and leave the other fields empty.\n\nBake these conventions into ready_prompt so it is safe to run:\n- One concern per change, with an explicit do-not-touch list.\n- Follow DESIGN-SYSTEM.md: semantic tokens only, never raw hex/hsl or raw palette utilities.\n- RED surfaces that need explicit human approval and must not be edited casually: processLead, the four LeadByteConnectors and their enabled states, Conversion Events, distribution_mode (only via distributionSetMode), credentials, live endpoints, billing records, buyer pricing and state coverage.\n- Additive schema only. No em dashes anywhere. Checkpoint before any schema or destructive change. Verify with the design-token gate and lint.\n\nready_prompt must be a complete, copy-pasteable instruction a builder can act on: the target area, the exact change, the do-not-touch list, and the verification step. Set risk=red if the request touches any RED surface, amber if it touches shared or data surfaces, green for isolated UI or docs.`;
  const prompt = `Conversation so far:\n${convo || '(none)'}\n\nUser request: ${question}\n\nReturn a JSON object only, with keys: is_build (boolean), title (string), summary (string), target_files (array of strings), do_not_touch (array of strings), risk (one of "green", "amber", "red"), ready_prompt (string). Required: is_build, title, summary, ready_prompt.`;
  return await callJson({ system, prompt, temperature: 0.2 });
}

// Extract learnable facts from a conversation exchange. Returns up to 3 facts.
async function extractMemories(question, answer, existingMemory) {
  const existingStr = existingMemory.slice(0, 20).map(m => `- ${m.fact}`).join('\n');
  const system = `You extract durable, reusable facts and preferences from a conversation between a user and an analytics assistant. Only extract facts that will be useful in future conversations: business rules, user preferences, recurring data insights, or definitions the user provided. Do NOT extract transient questions or answers. Do NOT duplicate facts already known.\n\nKnown memories:\n${existingStr || '(none)'}`;
  const prompt = `User asked: ${question}\nAssistant answered: ${answer}\n\nExtract up to 3 new memories. Return a JSON object only, of the form { "memories": [ { "fact": string, "category": one of "preference" | "business_rule" | "data_insight" | "definition" | "other" } ] }.`;
  try {
    const result = await callJson({ system, prompt, temperature: 0.2 });
    return Array.isArray(result?.memories) ? result.memories.filter(m => m.fact && m.fact.length > 5).slice(0, 3) : [];
  } catch { return []; }
}

export default async function dataBot(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  try {
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
      const role = u.base_role || u.role;
      let p = {};
      try { p = u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) : {}; } catch { p = {}; }
      // databot is on by default for all roles; only off if explicitly set to false
      const databot = p.databot === false ? false : true;
      // buildbot: on for owner/admin by default, off for partners
      const buildbotDefault = (role === 'owner' || role === 'admin');
      const buildbot = p.buildbot !== undefined ? !!p.buildbot : buildbotDefault;
      return { databot, buildbot };
    };
    const isPartner = user.base_role === 'supplier' || user.base_role === 'buyer' || !!user.linked_supplier_id || !!user.linked_buyer_id;
    const perms = resolvePerms(user);

    // Per-bot allow list, configured on the bot itself in Settings > ChatBot.
    //
    // When allowed_roles or allowed_user_ids is set, the bot is restricted to
    // exactly those and nothing else grants access. When both are empty it
    // returns null and the permission flag below decides, which is how it
    // behaved before, so an unconfigured bot keeps working for owners/admins.
    //
    // Resolved BEFORE any work happens. Enforced server side: the UI hides the
    // launcher too, but hiding a button is not access control.
    const botAllows = async (botKey, u) => {
      try {
        const cfgs = await db.entities.BotConfig.filter({ bot_key: botKey });
        const cfg = (Array.isArray(cfgs) ? cfgs : [])[0] || null;
        if (!cfg) return null;
        const roles = Array.isArray(cfg.allowed_roles) ? cfg.allowed_roles.filter(Boolean) : [];
        const ids = Array.isArray(cfg.allowed_user_ids) ? cfg.allowed_user_ids.filter(Boolean) : [];
        if (roles.length === 0 && ids.length === 0) return null; // not configured
        const role = String(u.base_role || u.role || '').toLowerCase();
        return roles.map((r) => String(r).toLowerCase()).includes(role) || ids.includes(u.id);
      } catch {
        return null; // never lock an operator out because a lookup failed
      }
    };

    const buildAllow = await botAllows('build', user);
    const dataAllow = await botAllows('data', user);

    // An explicit allow list overrides the permission flag in both directions.
    const canData = dataAllow === null ? !!perms.databot : dataAllow;
    const canBuild = !isPartner && (buildAllow === null ? !!perms.buildbot : buildAllow);

    // Friendly, actionable message instead of a silent 500 when the key is unset.
    const llmKey = ctx.config?.integrations?.openaiApiKey || ctx.env?.OPENAI_API_KEY;
    if (!llmKey) {
      return { type: 'answer', answer: 'This assistant is not configured yet: the language model API key is missing. An admin can add it in the app secrets, then I can answer.' };
    }

    // BuildBot: draft a single-concern build request for the controlled channel.
    if (mode === 'build') {
      if (!canBuild) {
        return {
          type: 'answer',
          answer: buildAllow === false
            ? 'BuildBot is restricted to specific roles or people, and your account is not on that list. An admin can change this in Settings > ChatBot > BuildBot.'
            : 'BuildBot is not enabled for your account. An admin can grant the BuildBot permission in Users and Roles.',
        };
      }
      try {
        const draft = await draftBuildRequest(question, history);
        if (draft && draft.is_build) return { type: 'build_request', build_request: draft };
      } catch (_) { /* not a build, or draft failed: fall through to an answer */ }
    }

    if (!canData) {
      return {
        type: 'answer',
        answer: dataAllow === false
          ? 'DataBot is restricted to specific roles or people, and your account is not on that list. An admin can change this in Settings > ChatBot > DataBot.'
          : 'DataBot access is turned off for your account. An admin can enable it in Users and Roles.',
      };
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
      pastConversations = recentConvs.map(c => {
        let msgs = [];
        try { msgs = JSON.parse(c.messages || '[]'); } catch {}
        const lastMsgs = msgs.slice(-4);
        return { title: c.title, recent: lastMsgs.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`) };
      });
    } catch { /* memory entities may not exist yet */ }

    // --- Resolve caller scope (deny-by-default), then gather only what they may see ---
    let scope = { kind: 'none', id: null };
    if (isAdmin) scope = { kind: 'operator', id: null };
    else if (user.base_role === 'supplier' || user.linked_supplier_id) scope = { kind: 'supplier', id: user.linked_supplier_id || null };
    else if (user.base_role === 'buyer' || user.linked_buyer_id) scope = { kind: 'buyer', id: user.linked_buyer_id || null };

    const sum = (a, f) => a.reduce((acc, x) => acc + (Number(f(x)) || 0), 0);
    const statusMap = (rows) => { const m = {}; for (const l of rows) m[l.final_status] = (m[l.final_status] || 0) + 1; return m; };

    // ---- Accurate, date-aware lead facts -------------------------------------
    //
    // The bot used to be handed a 500-row slice and 25 recent rows with no date
    // buckets at all, then asked questions like "how many sold yesterday". It
    // could not know, so it answered zero while the Leads page showed 15.
    //
    // Counting is done here, not by the model. Three rules matter and all three
    // match what the UI does:
    //   1. Archived leads are excluded. They are retired duplicates.
    //   2. The event date is the supplier's own timestamp where present, NOT
    //      created_date. created_date is when the row was written, so every
    //      lead from a bulk import carries the import date.
    //   3. Days are bucketed in America/Regina, the operating timezone, so
    //      "yesterday" means yesterday here rather than in UTC.
    const APP_TZ = 'America/Regina';
    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    });

    const parseBag = (l) => {
      try { return JSON.parse(l?.mapped_fields || '{}') || {}; } catch { return {}; }
    };

    // Mirrors leadEventInstant in src/lib/reportMetrics.js.
    const eventDayKey = (l) => {
      const bag = parseBag(l);
      const raw = bag.timestamp || bag.received || bag.date_created || null;
      let d = null;
      if (raw) {
        const s = String(raw).trim().replace(' ', 'T');
        d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
      }
      if (!d || isNaN(d.getTime())) {
        const c = l?.created_date;
        if (!c) return null;
        const s = String(c).trim();
        d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
      }
      return isNaN(d.getTime()) ? null : dayFmt.format(d);
    };

    const todayKey = dayFmt.format(new Date());
    const dayKeyOffset = (n) => dayFmt.format(new Date(Date.now() - n * 86400000));
    const yesterdayKey = dayKeyOffset(1);

    // Page past the 500-row cap so totals are real totals.
    const loadAllLeads = async () => {
      const out = [];
      const pageSize = 500;
      for (let p = 0; p < 200; p += 1) {
        const batch = await db.entities.Lead
          .filter({ archived: false }, '-created_date', pageSize, p * pageSize)
          .catch(() => []);
        if (!batch || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < pageSize) break;
      }
      return out;
    };

    // Counts by status for an arbitrary set of day keys.
    const countsForDays = (allLeads, dayKeys) => {
      const want = new Set(dayKeys);
      const rows = allLeads.filter((l) => { const k = eventDayKey(l); return k && want.has(k); });
      const byStatus = statusMap(rows);
      return {
        total: rows.length,
        sold: byStatus.Sold || 0,
        unsold: byStatus.Unsold || 0,
        disqualified: byStatus.Disqualified || 0,
        returned: byStatus.Returned || 0,
        rejected: byStatus.Rejected || 0,
        duplicate: byStatus.Duplicate || 0,
        revenue: Math.round(sum(rows, (l) => l.revenue)),
      };
    };

    const buildLeadFacts = (allLeads) => {
      const last7 = Array.from({ length: 7 }, (_, i) => dayKeyOffset(i));
      const last30 = Array.from({ length: 30 }, (_, i) => dayKeyOffset(i));
      const thisMonthPrefix = todayKey.slice(0, 7);
      const allKeys = allLeads.map(eventDayKey).filter(Boolean);
      const thisMonthKeys = [...new Set(allKeys.filter((k) => k.startsWith(thisMonthPrefix)))];
      const lastMonthDate = new Date();
      lastMonthDate.setDate(1);
      lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
      const lastMonthPrefix = dayFmt.format(lastMonthDate).slice(0, 7);
      const lastMonthKeys = [...new Set(allKeys.filter((k) => k.startsWith(lastMonthPrefix)))];

      // Per-day series so the model can answer "which day was best" without
      // inventing anything.
      const perDay = {};
      for (const k of last30) perDay[k] = countsForDays(allLeads, [k]);

      return {
        _note: 'Counts are authoritative. They exclude archived leads and bucket by the supplier event timestamp in America/Regina, matching the dashboard. Use these numbers directly; do not recount from recent_leads.',
        timezone: APP_TZ,
        today_date: todayKey,
        yesterday_date: yesterdayKey,
        all_time_total: allLeads.length,
        all_time_by_status: statusMap(allLeads),
        today: countsForDays(allLeads, [todayKey]),
        yesterday: countsForDays(allLeads, [yesterdayKey]),
        last_7_days: countsForDays(allLeads, last7),
        last_30_days: countsForDays(allLeads, last30),
        this_month: countsForDays(allLeads, thisMonthKeys),
        last_month: countsForDays(allLeads, lastMonthKeys),
        per_day_last_30: perDay,
      };
    };

    let dataSummary = {};
    let kbContext = '';
    let scopeNote = '';

    if (scope.kind === 'operator') {
      const [leads, suppliers, buyers, adSpend, txns, kbDocs] = await Promise.all([
        loadAllLeads(),
        db.entities.Supplier.list().catch(() => []),
        db.entities.Buyer.list().catch(() => []),
        db.entities.AdSpend.list('-date', 500).catch(() => []),
        db.entities.BankTransaction.list('-date', 300).catch(() => []),
        db.entities.KnowledgeDoc.filter({ active: true }, 'sort_order').catch(() => []),
      ]);
      dataSummary = {
        // Authoritative, date-bucketed counts. Answer date questions from here.
        lead_facts: buildLeadFacts(leads),
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
        recent_leads: leads.slice(0, 25).map((l) => ({ supplier: l.supplier_name, status: l.final_status, revenue: l.revenue, email_valid: l.email_valid, created: l.created_date, event_day: eventDayKey(l) })),
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
      ? memories.map(m => `- [${m.category}] ${m.fact}`).join('\n')
      : '(none yet)';

    // Format past conversations for continuity
    const pastConvContext = pastConversations.length
      ? pastConversations.map(c => `Conversation "${c.title}":\n${c.recent.join('\n')}`).join('\n\n')
      : '(none)';

    // Load bot config for model, temperature, instructions
    const botKey = mode === 'build' ? 'build' : 'data';
    let botConfig = {};
    try {
      const configs = await db.entities.BotConfig.filter({ bot_key: botKey }).catch(() => []);
      if (configs.length) botConfig = configs[0];
    } catch {}
    const botTemp = botConfig.temperature ?? 0.4;
    const botInstructions = botConfig.instructions || '';
    const botName = botConfig.name || (mode === 'build' ? 'BuildBot' : 'DataBot');
    const prompt = `You are ${botName}, an analytics assistant embedded in the Legenex lead-management platform.
Answer the user's question using ONLY the data and knowledge base below. Be concise, specific, and use numbers from the data. If the data does not contain the answer, say so plainly.
${scopeNote ? `SCOPE (strict): ${scopeNote}\n` : ''}
COUNTING LEADS: when the question involves a date or period (today, yesterday, this week, this month, a named day), read the answer from lead_facts. It is pre-computed and authoritative: it excludes archived duplicates, buckets by the supplier's own event timestamp rather than the row's created_date, and uses the America/Regina operating timezone. lead_facts.yesterday.sold is the number of leads sold yesterday. lead_facts.per_day_last_30 is keyed by date for single-day questions. NEVER count rows in recent_leads to answer these: it is a 25-row sample for context only, and answering from it is how this assistant previously reported zero sold leads on a day with fifteen. If lead_facts does not cover the period asked about, say which periods you do have rather than estimating.
When asked where a figure comes from, trace it through any ad_spend breakdowns present and name the date, supplier and account; a number that does not match a total may match a single day. If ad_spend_date_range shows the latest date is well before today, say the spend looks stale and give that date.

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

    const answer = await callText({ prompt, temperature: botTemp, system: botInstructions || undefined });

    const answerStr = typeof answer === 'string' ? answer : JSON.stringify(answer);

    // --- Persist the conversation and extract memories (async, non-blocking) ---
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
