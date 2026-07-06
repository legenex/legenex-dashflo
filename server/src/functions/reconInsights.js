import { callLLM } from '../integrations/llm.js';

// Produces AI reconciliation insights over per-counterparty gaps. Admin-only.
// Uses the configured LLM provider via the llm adapter.
export default async function reconInsights(ctx) {
  try {
    const user = ctx.user;
    if (!user || user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const gaps = body.gaps || [];
    if (!Array.isArray(gaps) || gaps.length === 0) {
      return { insights: 'No open reconciliation gaps to analyze.' };
    }

    const summary = gaps.slice(0, 40).map((g) =>
      `${g.name} (${g.type}): expected ${g.expected}, paid ${g.paid}, short ${g.short}`
    ).join('\n');

    const result = await callLLM({
      temperature: 0.4,
      prompt: `You are a finance ops analyst for a lead-gen business. Given open reconciliation gaps between what counterparties owe/were owed (expected) and what was actually paid, give a short, punchy set of insights (max 5 bullet points). Focus on biggest risks, patterns, and what to chase first. Be concrete.

Open gaps:
${summary}`,
    });

    return { insights: String(result || '') };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
