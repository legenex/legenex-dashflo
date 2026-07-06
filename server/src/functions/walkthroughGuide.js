import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// AI-guided onboarding walkthrough.
export default async function walkthroughGuide(ctx) {
  try {
    const user = requireUser(ctx);

    const body = ctx.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const system = `You are the Legenex DashFlo onboarding guide. Legenex DashFlo is a lead-distribution and marketing-finance platform.
Teach the user, step by step, how to set up and use the platform. Cover these areas in a logical order, one focused step at a time:
1. Connecting lead sources (suppliers) — where leads flow in, and how the inbound endpoint / API keys work (Settings > API Keys, Settings > Data Sources, Deliveries).
2. Mapping ad campaigns to a vertical, brand and supplier so spend produces a true cost-per-lead (Settings > Integrations > Meta Ad Spend, and Campaigns for verticals/buyers/suppliers/brands).
3. Configuring lead delivery to buyers (Deliveries) and conversion events (Conversion Events).
4. Reading the Overview dashboard (financial truth — profit, revenue, cost, reconciliation health) and the Distribution dashboard (operational pipeline — volume, status mix, verification, source performance).

Style: warm, concise, practical. Give ONE clear step at a time with the exact page/menu path to click. End each step by asking if they're ready for the next one, or if they want more detail. Keep responses under 130 words. Use short markdown lists where helpful. Never invent features that weren't described here.`;

    const convo = messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Guide'}: ${m.content}`)
      .join('\n\n');

    const prompt = messages.length === 0
      ? `Start the walkthrough. Greet the user by name (${user.full_name || 'there'}) in one sentence, briefly say what you'll cover, then give the very first step.`
      : `Conversation so far:\n\n${convo}\n\nContinue as the Guide with the next helpful reply.`;

    const reply = await callLLM({ system, prompt, temperature: 0.4 });

    return { reply: typeof reply === 'string' ? reply : String(reply) };
  } catch (error) {
    if (error.status) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
