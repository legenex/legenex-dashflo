// Pure JSON-object-string <-> rows conversion shared by every key/value row
// editor (SubDelivery.headers, SubDelivery.query_params, and the Form-format
// payload editor's reuse of payload_template). Kept separate from the React
// component so the actual serialization contract - what an operator's rows
// turn into on disk, and what a stored value turns into on screen - is
// testable without a DOM.
export function parseKeyValueRows(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
  } catch {
    return [];
  }
}

export function serializeKeyValueRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const key = (r.key || '').trim();
    if (!key) continue;
    out[key] = r.value ?? '';
  }
  return Object.keys(out).length ? JSON.stringify(out) : '';
}
