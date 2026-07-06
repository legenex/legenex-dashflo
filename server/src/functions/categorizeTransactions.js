import { invokeLLM } from '../integrations/llm.js';

// AI-categorizes uncategorized BankTransaction records into
// tech / media / personal / payouts / revenue / other. Admin-only.
// Uses the configured LLM provider via the llm adapter.
export default async function categorizeTransactions(ctx) {
  try {
    const user = ctx.user;
    if (!user || user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

    const db = ctx.db;
    const all = await db.entities.BankTransaction.list('-date', 500);
    const uncategorized = all.filter((t) => !t.category);

    let updated = 0;
    if (uncategorized.length > 0) {
      // Batch to keep the prompt small.
      const batch = uncategorized.slice(0, 100);
      const list = batch.map((t, i) => `${i}. ${t.description || '(no description)'} | amount ${t.amount}`).join('\n');
      const result = await invokeLLM({
        temperature: 0.2,
        prompt: `You are a bookkeeping assistant for a lead-generation business. Categorize each bank transaction into exactly one of: tech, media, personal, payouts, revenue, other.
- tech: software, SaaS, hosting, APIs, tools
- media: ad spend, marketing, agencies, creative
- personal: owner personal expenses, non-business
- payouts: paying suppliers / affiliates
- revenue: money received from buyers / clients (positive amounts)
- other: anything else

Transactions:
${list}

Return JSON with an array "items" of { index, category }.`,
        response_json_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', properties: { index: { type: 'number' }, category: { type: 'string' } } },
            },
          },
        },
      });
      const items = result?.items || [];
      for (const it of items) {
        const t = batch[it.index];
        if (t && ['tech', 'media', 'personal', 'payouts', 'revenue', 'other'].includes(it.category)) {
          await db.entities.BankTransaction.update(t.id, { category: it.category, ai_categorized: true });
          updated++;
        }
      }
    }

    // Summary stats.
    const refreshed = await db.entities.BankTransaction.list('-date', 500);
    const moneyIn = refreshed.filter((t) => t.amount > 0).reduce((a, t) => a + Number(t.amount), 0);
    const moneyOut = refreshed.filter((t) => t.amount < 0).reduce((a, t) => a + Number(t.amount), 0);
    const byCat = {};
    for (const t of refreshed) { const c = t.category || 'uncategorized'; byCat[c] = (byCat[c] || 0) + Number(t.amount); }

    return { success: true, updated, money_in: moneyIn, money_out: moneyOut, by_category: byCat };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
