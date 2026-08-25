import { describe, it, expect } from 'vitest';
import { parseKeyValueRows, serializeKeyValueRows } from './keyValueRows.js';

describe('parseKeyValueRows / serializeKeyValueRows', () => {
  it('round-trips a flat JSON object into rows and back', () => {
    const rows = parseKeyValueRows('{"X-Env":"prod","X-Source":"native"}');
    expect(rows).toEqual([{ key: 'X-Env', value: 'prod' }, { key: 'X-Source', value: 'native' }]);
    expect(serializeKeyValueRows(rows)).toBe(JSON.stringify({ 'X-Env': 'prod', 'X-Source': 'native' }));
  });

  it('an operator never has to hand-write raw JSON - a token-valued row round-trips untouched', () => {
    const rows = parseKeyValueRows('{"zip":"{{zip}}"}');
    expect(rows).toEqual([{ key: 'zip', value: '{{zip}}' }]);
    expect(serializeKeyValueRows(rows)).toBe('{"zip":"{{zip}}"}');
  });

  it('parses to an empty list for a blank, null, or undefined value', () => {
    expect(parseKeyValueRows('')).toEqual([]);
    expect(parseKeyValueRows('   ')).toEqual([]);
    expect(parseKeyValueRows(null)).toEqual([]);
    expect(parseKeyValueRows(undefined)).toEqual([]);
  });

  it('parses to an empty list (fails closed) for invalid JSON or a non-object shape, rather than throwing', () => {
    expect(parseKeyValueRows('{not json')).toEqual([]);
    expect(parseKeyValueRows('["a","b"]')).toEqual([]);
    expect(parseKeyValueRows('"just a string"')).toEqual([]);
    expect(parseKeyValueRows('42')).toEqual([]);
  });

  it('serializes an empty row list to an empty string, not "{}"', () => {
    expect(serializeKeyValueRows([])).toBe('');
    expect(serializeKeyValueRows(undefined)).toBe('');
  });

  it('drops a row with a blank key on serialize', () => {
    expect(serializeKeyValueRows([{ key: '', value: 'x' }, { key: '  ', value: 'y' }, { key: 'ok', value: 'z' }]))
      .toBe(JSON.stringify({ ok: 'z' }));
  });

  it('a later duplicate key wins, matching plain object assignment semantics', () => {
    expect(serializeKeyValueRows([{ key: 'a', value: '1' }, { key: 'a', value: '2' }]))
      .toBe(JSON.stringify({ a: '2' }));
  });
});
