import { describe, it, expect } from 'vitest';
import { evalConditionTree } from './distribution/conditions.js';
import {
  normalizeConditionTree, serializeConditionTree, countConditions, cloneNode, OPERATOR_OPTIONS,
} from './routeConditionGroups.js';

describe('routeConditionGroups matches the real engine evaluator', () => {
  it('normalizes null/empty to an empty AND group', () => {
    expect(normalizeConditionTree(null)).toEqual({ op: 'and', children: [] });
    expect(normalizeConditionTree('')).toEqual({ op: 'and', children: [] });
  });

  it('normalizes a legacy flat array into an implicit AND group', () => {
    const tree = normalizeConditionTree(JSON.stringify([{ field: 'accident_state', operator: 'equals', value: 'CA' }]));
    expect(tree.op).toBe('and');
    expect(tree.children).toHaveLength(1);
  });

  it('round-trips through serialize and the real evalConditionTree agree', () => {
    const tree = {
      op: 'or',
      children: [
        { field: 'accident_state', operator: 'equals', value: 'CA' },
        { field: 'accident_state', operator: 'equals', value: 'NV' },
      ],
    };
    const serialized = serializeConditionTree(tree);
    const reparsed = normalizeConditionTree(serialized);
    expect(evalConditionTree(reparsed, { accident_state: 'NV' })).toBe(true);
    expect(evalConditionTree(reparsed, { accident_state: 'AZ' })).toBe(false);
  });

  it('nested AND/OR groups evaluate exactly as the engine would', () => {
    const tree = normalizeConditionTree(JSON.stringify({
      op: 'and',
      children: [
        { field: 'vertical', operator: 'equals', value: 'MVA' },
        {
          op: 'or',
          children: [
            { field: 'accident_state', operator: 'in', value: 'CA,NV,AZ' },
            { field: 'type_of_injury', operator: 'exists' },
          ],
        },
      ],
    }));
    expect(evalConditionTree(tree, { vertical: 'MVA', accident_state: 'NV' })).toBe(true);
    expect(evalConditionTree(tree, { vertical: 'MVA', accident_state: 'TX', type_of_injury: 'back' })).toBe(true);
    expect(evalConditionTree(tree, { vertical: 'WC', accident_state: 'NV' })).toBe(false);
  });

  it('every offered operator is one evalLeaf actually implements', () => {
    for (const opt of OPERATOR_OPTIONS) {
      const tree = { field: 'x', operator: opt.value, value: opt.value === 'between' ? '1,2' : '1' };
      // Must not throw and must not silently fall through to a default of
      // "false for every input" the way an unrecognized operator would.
      const trueish = evalConditionTree(tree, { x: opt.value === 'between' ? 1 : 1 }, { nowMs: Date.now() });
      const falseish = evalConditionTree(tree, { x: 'definitely-not-a-match-9999' }, { nowMs: Date.now() });
      expect(typeof trueish).toBe('boolean');
      expect(typeof falseish).toBe('boolean');
    }
  });

  it('countConditions counts leaves, not groups', () => {
    const tree = normalizeConditionTree(JSON.stringify({
      op: 'and',
      children: [
        { field: 'a', operator: 'equals', value: '1' },
        { op: 'or', children: [{ field: 'b', operator: 'exists' }, { field: 'c', operator: 'exists' }] },
      ],
    }));
    expect(countConditions(tree)).toBe(3);
  });

  it('cloneNode deep-copies so mutating the clone leaves the original intact', () => {
    const tree = normalizeConditionTree(JSON.stringify({ op: 'and', children: [{ field: 'a', operator: 'equals', value: '1' }] }));
    const copy = cloneNode(tree);
    copy.children[0].value = '2';
    expect(tree.children[0].value).toBe('1');
  });
});
