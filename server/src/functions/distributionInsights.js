import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// Distribution AI Insights: summarizes OPERATIONAL trends for a selected period.
// The frontend sends a pre-aggregated, revenue-free summary; we return a short narrative.
export default async function distributionInsights(ctx) {
  try {
    requireUser(ctx);

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

    const answer = await callLLM({ prompt, temperature: 0.4 });

    return { insights: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  } catch (error) {
    if (error.status) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
