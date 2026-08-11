import { requireUser } from './_runtime.js';

// Caller model: authenticated operator (admin) only.
//
// Diagnostic for the shared LLM dependency. Every AI feature routes through
// the shared LLM client, which tries OpenAI then falls back to Anthropic.
// This reports the live state of BOTH providers so an outage can be attributed
// in one look instead of guessed at. It never returns either key.

async function probeOpenAI(key) {
  if (!key) return { key_present: false, verdict: 'KEY_MISSING', detail: 'OPENAI_API_KEY is not set on this app.' };

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    return { key_present: true, verdict: 'NETWORK_BLOCKED', detail: e.message };
  }

  if (res.status === 401) return { key_present: true, http_status: 401, verdict: 'KEY_REJECTED', detail: 'Secret is set but OpenAI rejected it (revoked, deleted, or a different project).' };
  if (res.status === 429) return { key_present: true, http_status: 429, verdict: 'QUOTA_EXCEEDED', detail: 'Key is valid but the account is rate limited or out of billing credit.' };
  if (!res.ok) return { key_present: true, http_status: res.status, verdict: 'ERROR', detail: (await res.text()).slice(0, 300) };

  const data = await res.json();
  const ids = new Set((data?.data || []).map((m) => m.id));
  const required = ['gpt-4o-mini', 'gpt-4o'];
  const missing = required.filter((m) => !ids.has(m));
  return {
    key_present: true,
    http_status: 200,
    models_visible: ids.size,
    required_models: Object.fromEntries(required.map((m) => [m, ids.has(m)])),
    verdict: missing.length ? 'MODEL_UNAVAILABLE' : 'HEALTHY',
    detail: missing.length ? `Key works but these models are not available to it: ${missing.join(', ')}.` : 'Key valid and required models available.',
  };
}

async function probeAnthropic(key) {
  if (!key) return { key_present: false, verdict: 'KEY_MISSING', detail: 'ANTHROPIC_API_KEY is not set. There is no fallback if OpenAI fails.' };

  // Cheapest real call: a 1-token completion. The models endpoint alone does
  // not prove the key can actually bill a request.
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    });
  } catch (e) {
    return { key_present: true, verdict: 'NETWORK_BLOCKED', detail: e.message };
  }

  if (res.status === 401) return { key_present: true, http_status: 401, verdict: 'KEY_REJECTED', detail: 'Secret is set but Anthropic rejected it.' };
  if (res.status === 429) return { key_present: true, http_status: 429, verdict: 'QUOTA_EXCEEDED', detail: 'Key is valid but rate limited or out of credit.' };
  if (res.status === 404) return { key_present: true, http_status: 404, verdict: 'MODEL_UNAVAILABLE', detail: 'claude-haiku-4-5-20251001 is not available to this key.' };
  if (!res.ok) return { key_present: true, http_status: res.status, verdict: 'ERROR', detail: (await res.text()).slice(0, 300) };

  return { key_present: true, http_status: 200, verdict: 'HEALTHY', detail: 'Key valid and the fallback model responded.' };
}

export default async function aiHealth(ctx) {
  const user = requireUser(ctx);
  if (String(user.role || '').toLowerCase() !== 'admin') {
    return ctx.json({ error: 'Operator access required' }, 403);
  }

  try {
    const openaiKey = ctx.config?.integrations?.openaiApiKey || ctx.env.OPENAI_API_KEY;
    const anthropicKey = ctx.config?.integrations?.anthropicApiKey || ctx.env.ANTHROPIC_API_KEY;

    const [openai, anthropic] = await Promise.all([probeOpenAI(openaiKey), probeAnthropic(anthropicKey)]);

    // What the app will actually do right now.
    let overall;
    let summary;
    if (openai.verdict === 'HEALTHY') {
      overall = 'HEALTHY';
      summary = 'OpenAI is serving all AI features normally.';
    } else if (anthropic.verdict === 'HEALTHY') {
      overall = 'RUNNING_ON_FALLBACK';
      summary = `OpenAI is unavailable (${openai.verdict}) so every AI feature is being served by Anthropic. Nothing is broken, but the primary provider needs attention.`;
    } else {
      overall = 'ALL_PROVIDERS_DOWN';
      summary = `Both providers are unavailable. OpenAI: ${openai.verdict}. Anthropic: ${anthropic.verdict}. Every AI feature is dead until one is fixed.`;
    }

    return ctx.json(
      { checked_at: new Date().toISOString(), overall, summary, openai, anthropic },
      200,
    );
  } catch (error) {
    // Deliberately 200: a non-2xx makes the client throw and swallow the
    // reason, which is the exact failure mode this function exists to end.
    return ctx.json({ overall: 'DIAGNOSTIC_FAILED', summary: error.message }, 200);
  }
}
