import { requireUser } from './_runtime.js';
import { invokeLLM } from '../integrations/llm.js';

// Generates the "What's New" release highlights.
export default async function whatsNew(ctx) {
  try {
    requireUser(ctx);

    const changelog = `Recent changes to Legenex DashFlo:
- Added a Lead Distribution sub-sidebar to move quickly between Dashboard, Campaigns, Deliveries and Conversion Events.
- Added a profile menu at the bottom of the sidebar with a theme switcher (System / Light / Dark), settings and help links.
- Added an AI-guided Walk Through that helps set up the platform step by step.
- Added a new Profile settings page to edit name, email, timezone and Gmail connection.
- All AI features (DataBot, AI insights, walkthrough, this page) now run on the configured AI provider.`;

    const release = await invokeLLM({
      system: 'You write concise, upbeat product release notes for a SaaS lead-distribution platform. Focus on the user benefit of each change. No hype, no emojis.',
      prompt: `Turn the changelog below into a single release named "v1.0.0" with 4-6 short bullet points (max ~16 words each). Return strict JSON with keys version, date, items (array of strings).

${changelog}`,
      response_json_schema: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          date: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      temperature: 0.5,
    });

    if (!release || !Array.isArray(release.items)) {
      return ctx.json({ error: 'Could not generate release notes' }, 502);
    }
    return { release };
  } catch (error) {
    if (error.status) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
