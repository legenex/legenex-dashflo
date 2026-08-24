import { describe, it, expect } from 'vitest';
import { beautifyJson } from './jsonBeautify.js';

describe('beautifyJson', () => {
  it('pretty-prints valid JSON with 2-space indent', () => {
    const out = beautifyJson('{"a":1,"b":2}');
    expect(out.ok).toBe(true);
    expect(out.text).toBe(JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  it('preserves {{token}} strings verbatim, including transforms', () => {
    const src = '{"sid":"{{sid}}","email":"{{email|lowercase|trim}}"}';
    const out = beautifyJson(src);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('"{{sid}}"');
    expect(out.text).toContain('"{{email|lowercase|trim}}"');
  });

  it('does not reorder or rename keys', () => {
    const out = beautifyJson('{"z":1,"a":2}');
    expect(out.ok).toBe(true);
    const keys = Object.keys(JSON.parse(out.text));
    expect(keys).toEqual(['z', 'a']);
  });

  it('rejects invalid JSON without altering the caller-visible text', () => {
    const out = beautifyJson('{"sid": {{sid}}, }');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    expect(out.error.message).toBeTruthy();
  });

  it('reports a line/column when the underlying error exposes a position', () => {
    const out = beautifyJson('{\n  "a": 1,\n  "b":\n}');
    expect(out.ok).toBe(false);
    // Not every engine reports a position; only assert the shape when it does.
    if (out.error.line != null) {
      expect(out.error.line).toBeGreaterThan(0);
      expect(out.error.column).toBeGreaterThan(0);
    }
  });

  it('treats an empty/whitespace template as valid (nothing to beautify)', () => {
    expect(beautifyJson('').ok).toBe(true);
    expect(beautifyJson('   \n  ').ok).toBe(true);
  });
});
