// Beautify for a JSON payload template that contains {{token}} placeholders.
//
// JSON.parse/stringify round-trips a template like {"a": "{{sid}}"} without any
// special handling, because the tokens live inside ordinary JSON string values.
// The only real risk is a template the operator is mid-typing being invalid
// JSON; in that case we must never overwrite what they typed.

export function beautifyJson(text) {
  const src = String(text ?? '');
  if (src.trim() === '') {
    return { ok: true, text: src };
  }
  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch (err) {
    return { ok: false, error: describeJsonError(src, err) };
  }
  return { ok: true, text: JSON.stringify(parsed, null, 2) };
}

// Best-effort line/column for a JSON.parse SyntaxError. V8's message carries a
// character position ("... at position 42"); Node/browsers vary, so this
// degrades gracefully to just the raw message when no position is found.
export function describeJsonError(src, err) {
  const message = err && err.message ? err.message : 'Invalid JSON';
  const match = /position (\d+)/.exec(message);
  if (!match) return { message, line: null, column: null };
  const pos = Number(match[1]);
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === '\n') { line++; column = 1; } else { column++; }
  }
  return { message, line, column };
}
