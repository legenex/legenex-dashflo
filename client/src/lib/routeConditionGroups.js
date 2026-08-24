// Shared helpers for the nested AND/OR condition tree shape the routing engine
// actually executes: RouteMember.conditions.
//
// This is a DIFFERENT, incompatible shape from client/src/lib/conditionGroups.js
// (used by LeadByteConnector.filter_conditions / ConnectorConditionsEditor). That
// shape is { type:'group', match:'all'|'any', children } / { type:'condition' }.
// The engine's real evaluator (client/src/lib/distribution/conditions.js,
// evalConditionTree) reads { op:'and'|'or', children } / { field, operator, value }
// with no `type` discriminator. Writing the legacy shape into RouteMember.conditions
// would pass client-side validation and then silently fail every condition at
// runtime (evalLeaf's default case returns false), so the two must never be mixed.
//
// Operator semantics are pinned to conditions.js's evalLeaf exactly:
//   in / not_in      -> comma-separated list, matched case-insensitively
//   gt/gte/lt/lte     -> numeric compare
//   between           -> "min,max" (two comma-separated numbers)
//   matches           -> regex tested against the raw field value
//   exists/not_exists -> no value
//   within_months     -> number of months, compared against the evaluation clock

import { OPERATORS } from './distribution/conditions.js';

export const OPERATOR_LABELS = {
  equals: 'equals',
  not_equals: 'not equals',
  contains: 'contains',
  not_contains: 'does not contain',
  in: 'is any of (comma-separated)',
  not_in: 'is none of (comma-separated)',
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
  between: 'between (min,max)',
  matches: 'matches (regex)',
  exists: 'is not blank',
  not_exists: 'is blank',
  within_months: 'within trailing months',
};

// Built from the engine's own OPERATORS constant so the UI can never drift
// ahead of (or behind) what evalLeaf actually implements.
export const OPERATOR_OPTIONS = OPERATORS.map((value) => ({
  value,
  label: OPERATOR_LABELS[value] || value,
}));

export const VALUE_LESS_OPS = ['exists', 'not_exists'];

function emptyRoot() {
  return { op: 'and', children: [] };
}

function isGroup(node) {
  return node && typeof node === 'object' && Array.isArray(node.children);
}

// Accepts a JSON string, array, object, null, or undefined and returns a group
// tree in the engine's shape. A bare array is treated as an implicit AND
// (matching evalConditionTree's own array handling).
export function normalizeConditionTree(raw) {
  if (!raw) return emptyRoot();
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch { return emptyRoot(); }
  }
  if (Array.isArray(parsed)) {
    return {
      op: 'and',
      children: parsed.map((c) => ({
        field: c.field || '',
        operator: c.operator || 'equals',
        value: c.value ?? '',
      })),
    };
  }
  if (isGroup(parsed)) {
    return normalizeGroup(parsed);
  }
  return emptyRoot();
}

function normalizeGroup(node) {
  return {
    op: node.op === 'or' ? 'or' : 'and',
    children: (node.children || []).map((c) => (isGroup(c) ? normalizeGroup(c) : {
      field: c.field || '',
      operator: c.operator || 'equals',
      value: c.value ?? '',
    })),
  };
}

export function serializeConditionTree(tree) {
  return JSON.stringify(tree);
}

// Recursively count leaf condition nodes.
export function countConditions(tree) {
  if (!tree || typeof tree !== 'object') return 0;
  if (!isGroup(tree)) return 1;
  return (tree.children || []).reduce((sum, c) => sum + countConditions(c), 0);
}

// Deep copy a node.
export function cloneNode(node) {
  if (typeof structuredClone === 'function') return structuredClone(node);
  return JSON.parse(JSON.stringify(node));
}
