import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// AI Analyst briefing for the Overview command center.
// The frontend sends a pre-aggregated finance/lead summary; we return a short
// plain-English briefing via the configured LLM provider (Claude or OpenAI).
export default async function overviewBriefing(ctx) {
  requireUser(ctx);
  const summary = ctx.body?.summary;
  if (!summary) return ctx.json({ error: 'Missing summary' }, 400);

  const system =
    'You are a sharp CFO-level financial analyst for a lead-generation business. You read a reconciliation summary where "booked" means recorded from leads and "verified" means proven by real cash received. Write tight, specific, plain-English briefings. No hype, no emojis, no markdown headings.';

  const prompt = `Write a 3-4 sentence executive briefing for the current period based on this data. Cover, in order: (1) what changed vs the prior period, (2) where the biggest money-booked-but-not-yet-proven gap is, (3) which counterparty or campaign is the top risk, (4) the single most important action to take now. Be concrete with the dollar figures given. Keep it under 90 words.

DATA (JSON):
${JSON.stringify(summary)}`;

  try {
    const briefing = await callLLM({ prompt, system, temperature: 0.4, maxTokens: 500 });
    return { briefing: String(briefing || '').trim() };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
