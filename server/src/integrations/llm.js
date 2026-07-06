import { config } from '../config.js';

// Provider-agnostic LLM adapter. Set LLM_PROVIDER=anthropic|openai.
// Supports the two call shapes the app uses:
//   InvokeLLM({ prompt, response_json_schema, add_context_from_internet })
//   callLLM({ prompt, system, model, temperature, json })

async function callAnthropic({ prompt, system, model, temperature = 0.4, maxTokens = 1500, json = false }) {
  const apiKey = config.llm.anthropicApiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const messages = [{ role: 'user', content: prompt }];
  const body = {
    model: model || config.llm.anthropicModel,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (system) body.system = json ? `${system}\n\nRespond with valid JSON only, no prose.` : system;
  else if (json) body.system = 'Respond with valid JSON only, no prose.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.content?.map((c) => c.text).join('') ?? '';
}

async function callOpenAI({ prompt, system, model, temperature = 0.4, json = false }) {
  const apiKey = config.llm.openaiApiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = {
    model: model || config.llm.openaiModel,
    messages,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// Low-level: returns a string completion. Provider chosen by config (override
// with `provider`).
export async function callLLM(opts) {
  const provider = (opts.provider || config.llm.provider).toLowerCase();
  if (provider === 'openai') return callOpenAI(opts);
  return callAnthropic(opts);
}

// High-level: matches the platform's InvokeLLM integration.
// Returns parsed JSON when a response schema is supplied, else a string.
export async function invokeLLM({ prompt, response_json_schema, system, temperature, model } = {}) {
  const wantJson = !!response_json_schema;
  let sys = system || '';
  if (wantJson) {
    sys += `\nReturn a JSON object matching this JSON schema exactly: ${JSON.stringify(response_json_schema)}`;
  }
  const text = await callLLM({ prompt, system: sys.trim(), temperature, model, json: wantJson });
  if (!wantJson) return text;
  try {
    // Strip code fences if the model added them.
    const cleaned = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { _raw: text };
  }
}

export default { callLLM, invokeLLM };
