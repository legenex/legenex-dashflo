import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// DataBot: answers questions about the app's own data + a curated Knowledge Base.
export default async function dataBot(ctx) {
  try {
    requireUser(ctx);
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

=== LIVE APP DATA (JSON) ===
${JSON.stringify(dataSummary)}

=== KNOWLEDGE BASE ===
${kbContext || '(empty)'}

=== CONVERSATION SO FAR ===
${convo || '(none)'}

User: ${question}
DataBot:`;

    const answer = await callLLM({ prompt, temperature: 0.4 });

    return { answer: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  } catch (error) {
    if (error.status) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
