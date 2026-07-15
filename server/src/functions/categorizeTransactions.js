import { requireUser } from './_runtime.js';
import { callLLM } from '../integrations/llm.js';

// AI-categorizes uncategorized BankTransaction records. The taxonomy is read
// from the finance_settings IntegrationConfig so it stays in sync with the
// user-editable categories in Finances > Settings. Falls back to the original
// six categories when no settings record exists. Admin-only.

// Used only when no finance_settings record exists, parsing fails, or the
// categories array is empty. Matches the original hardcoded behavior.
const FALLBACK_CATEGORIES = [
  { key: 'tech', label: 'Software Tools', hint: 'software, SaaS, hosting, APIs, tools' },
  { key: 'media', label: 'Ad Spend', hint: 'ad spend, marketing, agencies, creative' },
  { key: 'personal', label: 'Personal', hint: 'owner personal expenses, non-business' },
  { key: 'payouts', label: 'Supplier Payouts', hint: 'paying suppliers / affiliates' },
  { key: 'revenue', label: 'Revenue', hint: 'money received from buyers / clients (positive amounts)' },
  { key: 'other', label: 'Other', hint: 'anything else' },
];

// Best-effort JSON extraction from an LLM text response. Mirrors the original
// behavior of returning {} when the model output cannot be parsed.
function parseJsonLoose(text) {
  if (text && typeof text === 'object') return text;
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  let candidate = raw;
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

async function categorizeBatch({ resolved, resolvedKeys, batch }) {
  const list = batch.map((t, i) => `${i}. ${t.description || '(no description)'} | amount ${t.amount}`).join('\n');
  const categoryLines = resolved.map((c) => `- ${c.key} (${c.label}): ${c.hint}`).join('\n');
  const out = await callLLM({
    prompt: `You are a bookkeeping assistant for a lead-generation business. Categorize each bank transaction into exactly one of: ${resolvedKeys.join(', ')}.
${categoryLines}

Transactions:
${list}

Return ONLY valid JSON (no markdown) with an array "items" of { index, category }.`,
    temperature: 0.2,
    maxTokens: 2000,
  });
  return parseJsonLoose(typeof out === 'string' ? out : (out?.text ?? out?.content ?? out));
}

export default async function categorizeTransactions(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

  const db = ctx.db;

  try {
    // Resolve the taxonomy from finance_settings, falling back to the six
    // original categories. Each resolved category exposes key, label and a
    // hint derived from its keywords.
    let resolved = FALLBACK_CATEGORIES;
    const cfg = (await db.entities.IntegrationConfig.filter({ name: 'finance_settings' }))[0] || null;
    if (cfg) {
      try {
        const parsed = JSON.parse(cfg.config || '{}');
        if (Array.isArray(parsed.categories) && parsed.categories.length > 0) {
          resolved = parsed.categories.map((c) => ({
            key: c.key,
            label: c.label || c.key,
            hint: Array.isArray(c.keywords) && c.keywords.length ? c.keywords.join(', ') : (c.label || c.key),
          }));
        }
      } catch { /* keep FALLBACK_CATEGORIES */ }
    }
    const resolvedKeys = resolved.map((c) => c.key);
    const keySet = new Set(resolvedKeys);

    const all = await db.entities.BankTransaction.list('-date', 500);
    const uncategorized = all.filter((t) => !t.category);

    let updated = 0;
    if (uncategorized.length > 0) {
      // Batch to keep the prompt small.
      const batch = uncategorized.slice(0, 100);
      const result = await categorizeBatch({ resolved, resolvedKeys, batch });
      const items = result?.items || [];
      for (const it of items) {
        const t = batch[it.index];
        if (t && keySet.has(it.category)) {
          await db.entities.BankTransaction.update(t.id, { category: it.category, ai_categorized: true });
          updated++;
        }
      }
    }

    // Summary stats.
    const refreshed = await db.entities.BankTransaction.list('-date', 500);
    const moneyIn = refreshed.filter((t) => t.amount > 0).reduce((a, t) => a + Number(t.amount), 0);
    const moneyOut = refreshed.filter((t) => t.amount < 0).reduce((a, t) => a + Number(t.amount), 0);
    const byCat = {};
    for (const t of refreshed) { const c = t.category || 'uncategorized'; byCat[c] = (byCat[c] || 0) + Number(t.amount); }

    return { success: true, updated, money_in: moneyIn, money_out: moneyOut, by_category: byCat, categories_used: resolvedKeys };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
