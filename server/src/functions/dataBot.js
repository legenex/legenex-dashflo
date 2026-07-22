import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
export default async function dataBot(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const body = ctx.body || {};
    const question = (body.question || '').toString().trim();
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    if (!question) return ctx.json({ error: 'No question provided' }, 400);

    // --- Gather a compact snapshot of live app data (full visibility) ---
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

    const answer = await callLLM({ prompt, temperature: 0.4 });

    return ctx.json({ answer: typeof answer === 'string' ? answer : JSON.stringify(answer) });
  } catch (error) {
    if (error && typeof error.status === 'number') {
      return ctx.json({ error: error.message }, error.status);
    }
    return ctx.json({ error: error.message }, 500);
  }
}
