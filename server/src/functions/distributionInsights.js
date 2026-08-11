import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// Distribution AI Insights: summarizes OPERATIONAL trends for a selected period.
// The frontend sends a pre-aggregated, revenue-free summary; we return a short narrative.
// Delegates to the shared LLM client: OpenAI first, automatic failover to
// Anthropic if OpenAI is unavailable for any reason.
// The name is kept so existing call sites are untouched.
async function callOpenAI({ prompt, system, model = 'gpt-4o-mini', temperature = 0.4, maxTokens } = {}) {
  return await callLLM({ prompt, system, model, temperature, maxTokens });
}

export default async function distributionInsights(ctx) {
  requireUser(ctx);

  try {
    const body = ctx.body || {};
    const summary = body.summary || {};
    const periodLabel = (body.periodLabel || 'the selected period').toString();

    const prompt = `You are an operations analyst for the Legenex lead-distribution platform.
Analyze ONLY the operational data below for ${periodLabel}. Do NOT mention revenue, profit, CPL, or any money — this is an operations view only.

Write 3-5 short bullet insights covering, where the data supports it:
- volume shifts vs the prior period
- rising disqualification (DQ) or error rates
- supplier or source anomalies (a source spiking, dropping, or with unusually high DQ/error/reject rates)
- notable status-mix changes (unsold, returns, rejections)

Be specific and use the actual numbers/percentages from the data. If a trend is flat or data is thin, say so briefly. Return plain text bullets starting with "- ". No preamble, no closing summary.

=== OPERATIONAL DATA (JSON) ===
${JSON.stringify(summary)}`;

    const answer = await callOpenAI({ prompt });

    return { insights: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
