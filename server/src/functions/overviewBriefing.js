import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// AI Analyst briefing for the Overview command center.
// The frontend sends a pre-aggregated finance/lead summary (current + prior period);
// we return a short plain-English briefing. Delegates to the shared LLM client:
// OpenAI first, with automatic failover to Anthropic if OpenAI is unavailable for
// any reason. The name is kept so existing call sites are untouched.
async function callOpenAI({ prompt, system, model = 'gpt-4o-mini', temperature = 0.4, maxTokens } = {}) {
  return await callLLM({ prompt, system, model, temperature, maxTokens });
}

export default async function overviewBriefing(ctx) {
  // Throws HttpError(401) when unauthenticated, so the 401 is preserved and is
  // not swallowed by the deliberate 200-on-error catch below.
  requireUser(ctx);

  const summary = ctx.body?.summary;
  if (!summary) return ctx.json({ error: 'Missing summary' }, 400);

  try {
    const system = 'You are a sharp CFO-level financial analyst for a lead-generation business. You read a reconciliation summary where "booked" means recorded from leads and "verified" means proven by real cash received. Write tight, specific, plain-English briefings. No hype, no emojis, no markdown headings.';

    const prompt = `Write a 3-4 sentence executive briefing for the current period based on this data. Cover, in order: (1) what changed vs the prior period, (2) where the biggest money-booked-but-not-yet-proven gap is, (3) which counterparty or campaign is the top risk, (4) the single most important action to take now. Be concrete with the dollar figures given. Keep it under 90 words.

DATA (JSON):
${JSON.stringify(summary)}`;

    const briefing = await callOpenAI({ prompt, system });
    return ctx.json({ briefing: String(briefing || '').trim() });
  } catch (error) {
    // Deliberately 200: a non-2xx makes the SDK throw on the client, which
    // replaced the real cause with a generic "could not generate" message and
    // left the operator with nothing to act on.
    return ctx.json({ error: error.message }, 200);
  }
}
