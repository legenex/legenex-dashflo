import { requireUser, HttpError } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
// Uses the shared LLM integration (reads its own credentials).

function normalizeText(out) {
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    return out.content ?? out.text ?? out.answer ?? out.output ?? JSON.stringify(out);
  }
  return String(out ?? '');
}

function parseJsonLoose(text) {
  let t = (text || '').trim();
  if (t.startsWith('')) {
    t = t.replace(/^(?:json)?/i, '').replace(/$/, '').trim();
  }
  try {
    return JSON.parse(t);
  } catch (_) {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s !== -1 && e !== -1 && e > s) {
      try { return JSON.parse(t.slice(s, e + 1)); } catch (_e) { /* fall through */ }
    }
    return null;
  }
}

// Change-intent phrasing that may warrant a drafted build request (admins only).
const BUILD_HINT = /\b(build|add|create|implement|make it|change|modify|edit|update the|remove|delete the|rename|redesign|refactor|wire|hook up|fix the|new (page|button|field|tab|section|report|column|widget|filter))\b/i;

// Scope a change request into a single-concern build prompt for the CONTROLLED
// channel (Claude via connector, the builder, or Claude Code). Never executes.
// If the message is really an analytics question, returns is_build=false.
async function draftBuildRequest(question, history) {
  const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'DataBot'}: ${m.content}`).join('\n');
  const system = `You scope change requests for the Legenex app so they can be handed to a controlled build channel (Claude via the connector, the builder, or Claude Code). You NEVER execute changes yourself. If the user's message is actually an analytics or data question rather than a request to change the app, set is_build=false and leave the other fields empty.\n\nBake these conventions into ready_prompt so it is safe to run:\n- One concern per change, with an explicit do-not-touch list.\n- Follow DESIGN-SYSTEM.md: semantic tokens only, never raw hex/hsl or raw palette utilities.\n- RED surfaces that need explicit human approval and must not be edited casually: processLead, the four LeadByteConnectors and their enabled states, Conversion Events, distribution_mode (only via distributionSetMode), credentials, live endpoints, billing records, buyer pricing and state coverage.\n- Additive schema only. No em dashes anywhere. Checkpoint before any schema or destructive change. Verify with the design-token gate and lint.\n\nready_prompt must be a complete, copy-pasteable instruction a builder can act on: the target area, the exact change, the do-not-touch list, and the verification step. Set risk=red if the request touches any RED surface, amber if it touches shared or data surfaces, green for isolated UI or docs.`;
  const prompt = `Conversation so far:\n${convo || '(none)'}\n\nUser request: ${question}\n\nReturn a JSON object with these keys: is_build (boolean), title (string), summary (string), target_files (array of strings), do_not_touch (array of strings), risk (one of 'green', 'amber', 'red'), ready_prompt (string). Required keys: is_build, title, summary, ready_prompt. Return JSON only, with no prose and no code fences.`;
  const raw = normalizeText(await callLLM({ system, prompt, temperature: 0.2 }));
  return parseJsonLoose(raw);
}

export default async function dataBot(ctx) {
  const user = requireUser(ctx);

  try {
    const body = ctx.body || {};
    const question = (body.question || '').toString().trim();
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    if (!question) return ctx.json({ error: 'No question provided' }, 400);

    const isAdmin = user.role === 'admin';

    // Friendly, actionable message instead of a silent 500 when the key is unset.
    const llmConfigured = Boolean(ctx.config?.integrations?.openaiApiKey || ctx.env?.OPENAI_API_KEY);
    if (!llmConfigured) {
      return { type: 'answer', answer: 'DataBot is not configured yet: the OPENAI_API_KEY secret is missing. An admin can add it in the app secrets, then I can answer.' };
    }

    // Build-request drafting (admins only), triggered only by change-intent phrasing.
    // Runs before the data snapshot so it stays fast and pulls no records.
    if (BUILD_HINT.test(question)) {
      if (!isAdmin) {
        return { type: 'answer', answer: 'Making changes to the app is available to admins only. I can still answer questions about your data and knowledge base.' };
      }
      try {
        const draft = await draftBuildRequest(question, history);
        if (draft && draft.is_build) {
          return { type: 'build_request', build_request: draft };
        }
      } catch (_) { /* not a build, or draft failed: fall through to an analytics answer */ }
    }

    // --- Gather a compact snapshot of live app data (full visibility) ---
    const db = ctx.db;
    const [leads, suppliers, buyers, adSpend, txns, kbDocs] = await Promise.all([
      db.entities.Lead.list('-created_date', 500).catch(() => []),
      db.entities.Supplier.list().catch(() => []),
      db.entities.Buyer.list().catch(() => []),
      db.entities.AdSpend.list('-date', 500).catch(() => []),
      db.entities.BankTransaction.list('-date', 300).catch(() => []),
      db.entities.KnowledgeDoc.filter({ active: true }, 'sort_order').catch(() => []),
    ]);

    const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
    const byStatus = {};
    for (const l of leads) byStatus[l.final_status] = (byStatus[l.final_status] || 0) + 1;

    const dataSummary = {
      leads_total: leads.length,
      leads_by_status: byStatus,
      revenue_total: Math.round(sum(leads, (l) => l.revenue)),
      suppliers_count: suppliers.length,
      supplier_names: suppliers.slice(0, 40).map((s) => s.name),
      buyers_count: buyers.length,
      buyer_names: buyers.slice(0, 40).map((b) => b.company_name),
      ad_spend_total: Math.round(sum(adSpend, (a) => a.spend)),
      // Ad spend breakdowns so questions like "where is this cost coming from"
      // can be answered with the actual source rows, not just a grand total.
      // Only account-level rows are totalled, matching how supplier cost is
      // computed, so campaign and ad detail rows do not double count.
      ad_spend_by_supplier: (() => {
        const m = {};
        for (const r of adSpend) {
          if (r.level && r.level !== 'account') continue;
          const k = r.supplier_name || '(unattributed)';
          m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100;
        }
        return m;
      })(),
      ad_spend_by_account: (() => {
        const m = {};
        for (const r of adSpend) {
          if (r.level && r.level !== 'account') continue;
          const k = r.cost_source || r.ad_account_id || '(unknown account)';
          m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100;
        }
        return m;
      })(),
      ad_spend_by_month: (() => {
        const m = {};
        for (const r of adSpend) {
          if (r.level && r.level !== 'account') continue;
          const k = String(r.date || '').slice(0, 7);
          if (!k) continue;
          m[k] = Math.round(((m[k] || 0) + (Number(r.spend) || 0)) * 100) / 100;
        }
        return m;
      })(),
      ad_spend_date_range: (() => {
        const ds = adSpend.map((r) => r.date).filter(Boolean).sort();
        return ds.length ? { earliest: ds[0], latest: ds[ds.length - 1], days: ds.length } : null;
      })(),
      ad_spend_recent_days: adSpend
        .filter((r) => !r.level || r.level === 'account')
        .slice(0, 45)
        .map((r) => ({
          date: r.date, spend: Number(r.spend) || 0, supplier: r.supplier_name || '',
          account: r.cost_source || r.ad_account_id || '', platform: r.platform || '', vertical: r.vertical || '',
        })),
      bank_money_in: Math.round(sum(txns.filter((t) => t.amount > 0), (t) => t.amount)),
      bank_money_out: Math.round(sum(txns.filter((t) => t.amount < 0), (t) => t.amount)),
      bank_unmatched: txns.filter((t) => !t.reconciled).length,
      recent_leads: leads.slice(0, 25).map((l) => ({
        supplier: l.supplier_name, status: l.final_status, revenue: l.revenue,
        email_valid: l.email_valid, created: l.created_date,
      })),
    };

    const kbContext = kbDocs.map((d) => {
      const head = d.kind === 'glossary' ? `${d.term || d.title}` : d.title;
      return `[${d.kind}] ${head}: ${d.content || ''}`;
    }).join('\n');

    const convo = history.map((m) => `${m.role === 'user' ? 'User' : 'DataBot'}: ${m.content}`).join('\n');

    const prompt = `You are DataBot, an analytics assistant embedded in the Legenex lead-management platform.
Answer the user's question using ONLY the live app data and knowledge base below. Be concise, specific, and use numbers from the data. If the data does not contain the answer, say so plainly.
When asked where a figure comes from, trace it through the breakdowns: ad_spend_by_supplier, ad_spend_by_account, ad_spend_by_month and ad_spend_recent_days hold per day ad spend with its supplier and ad account, so match the amount against those rows and name the date, supplier and account. A number that does not match a total may match a single day. Check ad_spend_date_range as well: if the latest spend date is well before today, say the spend data looks stale and give that latest date.

=== LIVE APP DATA (JSON) ===
${JSON.stringify(dataSummary)}

=== KNOWLEDGE BASE ===
${kbContext || '(empty)'}

=== CONVERSATION SO FAR ===
${convo || '(none)'}

User: ${question}
DataBot:`;

    const answer = normalizeText(await callLLM({ prompt, temperature: 0.4 }));

    return { type: 'answer', answer: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
