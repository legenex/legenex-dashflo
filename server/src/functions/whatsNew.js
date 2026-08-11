import { requireUser, HttpError } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// Generates the "What's New" release highlights via the shared LLM client:
// OpenAI first, with automatic failover to Anthropic if OpenAI is unavailable.
// The name is kept so existing call sites are untouched.
async function callOpenAI({ prompt, system, model = 'gpt-4o-mini', temperature = 0.4, maxTokens, jsonSchema } = {}) {
  return await callLLM({ prompt, system, model, temperature, maxTokens, jsonSchema });
}

function parseRelease(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  if (typeof result !== 'string') return null;

  let text = result.trim();
  const fenced = text.match(/(?:json)?\s*([\s\S]*?)/i);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default async function whatsNew(ctx) {
  try {
    requireUser(ctx);

    const changelog = `Recent changes to Legenex DashFlo:
- Added a Lead Distribution sub-sidebar to move quickly between Dashboard, Campaigns, Deliveries and Conversion Events.
- Added a profile menu at the bottom of the sidebar with a theme switcher (System / Light / Dark), settings and help links.
- Added an AI-guided Walk Through that helps set up the platform step by step.
- Added a new Profile settings page to edit name, email, timezone and Gmail connection.
- All AI features (DataBot, AI insights, walkthrough, this page) now run on OpenAI.`;

    const raw = await callOpenAI({
      system: 'You write concise, upbeat product release notes for a SaaS lead-distribution platform. Focus on the user benefit of each change. No hype, no emojis.',
      prompt: `Turn the changelog below into a single release named "v1.0.0" with 4-6 short bullet points (max ~16 words each). Return strict JSON with keys version, date, items (array of strings).

${changelog}`,
      jsonSchema: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          date: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
    });

    const release = parseRelease(raw);

    if (!release || !Array.isArray(release.items)) {
      return ctx.json({ error: 'Could not generate release notes' }, 502);
    }
    return { release };
  } catch (error) {
    if (error instanceof HttpError) {
      return ctx.json({ error: error.message }, error.status);
    }
    return ctx.json({ error: error.message }, 500);
  }
}
