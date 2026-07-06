// Finance Settings: the mapping brain for the Finances section.
// Persists as JSON on IntegrationConfig(name='finance_settings'), mirroring the
// Mercury config pattern, so there is no new entity schema. Categories, matching
// rules, counterparty aliases, and accounts all live here and feed the Bank Feed
// category chips, the Resolve flow, and the expense-mapping drawer.
import { api } from '@/api/client';

const CONFIG_NAME = 'finance_settings';

// Default taxonomy. Keys align with the CAT_STYLE map used in the Bank Feed.
export const DEFAULT_CATEGORIES = [
  { id: 'cat_revenue', key: 'revenue', label: 'Revenue', keywords: ['cashback', 'legenex llc', 'deposit'] },
  { id: 'cat_media', key: 'media', label: 'Media / Ad Spend', keywords: ['facebk', 'facebook', 'meta', 'google ads', 'tiktok', 'taboola'] },
  { id: 'cat_tech', key: 'tech', label: 'Tech / Software', keywords: ['openai', 'aws', 'google cloud', 'vercel', 'api'] },
  { id: 'cat_payouts', key: 'payouts', label: 'Supplier Payouts', keywords: [] },
  { id: 'cat_personal', key: 'personal', label: 'Personal', keywords: [] },
  { id: 'cat_other', key: 'other', label: 'Other', keywords: [] },
];

export function emptySettings() {
  return { categories: DEFAULT_CATEGORIES, matchRules: [], counterparties: [], accounts: [] };
}

// Load the persisted finance settings, falling back to defaults.
export async function loadFinanceSettings() {
  const rec = (await api.entities.IntegrationConfig.filter({ name: CONFIG_NAME }))[0] || null;
  if (!rec) return { id: null, settings: emptySettings() };
  let parsed = {};
  try { parsed = JSON.parse(rec.config || '{}'); } catch { parsed = {}; }
  return {
    id: rec.id,
    settings: {
      categories: parsed.categories?.length ? parsed.categories : DEFAULT_CATEGORIES,
      matchRules: parsed.matchRules || [],
      counterparties: parsed.counterparties || [],
      accounts: parsed.accounts || [],
    },
  };
}

// Persist the whole settings object. Creates the row on first save.
export async function saveFinanceSettings(id, settings) {
  const payload = JSON.stringify(settings);
  if (id) return api.entities.IntegrationConfig.update(id, { config: payload });
  return api.entities.IntegrationConfig.create({ name: CONFIG_NAME, config: payload });
}

// Suggest a counterparty for a bank description using explicit rules first,
// then counterparty aliases, then a loose name match. Returns null if unsure.
export function suggestMatch(description, settings) {
  const desc = (description || '').toLowerCase();
  if (!desc || !settings) return null;

  for (const r of settings.matchRules || []) {
    const pat = (r.pattern || '').toLowerCase();
    if (pat && desc.includes(pat)) {
      return { entity_type: r.entity_type, entity_name: r.entity_name, reason: `rule "${r.pattern}"`, confidence: 0.95 };
    }
  }
  for (const c of settings.counterparties || []) {
    for (const alias of c.aliases || []) {
      const a = (alias || '').toLowerCase();
      if (a && desc.includes(a)) {
        return { entity_type: c.type, entity_name: c.name, reason: `alias "${alias}"`, confidence: 0.85 };
      }
    }
    if (c.name && desc.includes(c.name.toLowerCase())) {
      return { entity_type: c.type, entity_name: c.name, reason: 'name match', confidence: 0.7 };
    }
  }
  return null;
}

// Suggest a category for a description using category keywords.
export function suggestCategory(description, settings) {
  const desc = (description || '').toLowerCase();
  if (!desc || !settings) return null;
  for (const cat of settings.categories || []) {
    for (const kw of cat.keywords || []) {
      if (kw && desc.includes(kw.toLowerCase())) {
        return { key: cat.key, label: cat.label, reason: `keyword "${kw}"` };
      }
    }
  }
  return null;
}

let _id = 0;
export const newId = (prefix = 'fs') => `${prefix}_${Date.now().toString(36)}_${(_id++).toString(36)}`;
