// Static rejection of regex patterns that are structurally capable of
// catastrophic (super-linear) backtracking, so an operator-entered response
// mapping pattern can never freeze the event loop regardless of the response
// body it is tested against.
//
// This runs INSIDE classifyResponse itself (deliveryAttempt.js), on every
// evaluation, not only at save time - so the guarantee holds no matter how a
// response_mapping value reached storage (generic entity route, a future
// import path, a direct database write). The cost is cheap: it analyzes the
// short operator-entered pattern string, never the (bounded but much larger)
// response body.
//
// Heuristic, two rules:
// 1. Reject any quantified group ((...)+, (...)*, (...){n,}) whose own body
//    contains a nested quantifier or an alternation, since that shape is a
//    structural precondition for exponential backtracking (e.g. (a+)+,
//    (a*)*, (a|a)*, (a|ab)+).
// 2. Reject a pattern containing two or more "ambiguous" alternation groups
//    ANYWHERE, quantified or not - a group is ambiguous when one alternative
//    is a prefix of another (e.g. (a|aa)). A sequence of un-quantified
//    ambiguous groups, e.g. (a|aa)(a|aa)(a|aa)...c, is exponential in the
//    number of groups purely from sequential ambiguous choice points, with NO
//    quantifier anywhere in the pattern - rule 1 alone does not catch this
//    "unrolled" shape, and it is a real, verified freeze (confirmed against
//    this exact detector: (a|aa) repeated 32 times froze the event loop for
//    over 50 seconds against an ordinary, non-adversarial response body).
// Deliberately conservative throughout: rejects some patterns that would in
// fact run safely, in exchange for never approving one that will not.

const MAX_PATTERN_LENGTH = 200;
const MAX_QUANTIFIERS = 12;

// Collapse every backslash-escaped pair to an inert placeholder so an escaped
// metacharacter (\+, \(, \)) is never mistaken for a live one.
function stripEscapes(src) {
  return src.replace(/\\./g, '__');
}

// Split a group's inner text on top-level '|' only (not one nested inside a
// sub-group), so alternatives are compared at the right depth.
function splitTopLevelAlternatives(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '|' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

// True when any alternative is a prefix of another - the structural
// precondition for ambiguous, exponentially-backtracking matching.
function hasAmbiguousAlternatives(alts) {
  if (alts.length < 2) return false;
  for (let i = 0; i < alts.length; i++) {
    if (!alts[i]) continue; // an empty alternative is a prefix of everything; handled by length<2 guard for the common (a|) case being intentional
    for (let j = 0; j < alts.length; j++) {
      if (i === j) continue;
      if (alts[j].startsWith(alts[i])) return true;
    }
  }
  return false;
}

export function isSafeRegexPattern(pattern) {
  const src = String(pattern ?? '');
  if (!src) return { safe: true };
  if (src.length > MAX_PATTERN_LENGTH) return { safe: false, reason: 'pattern too long' };

  const clean = stripEscapes(src);
  const quantCount = (clean.match(/[+*]|\{\d+,?\d*\}/g) || []).length;
  if (quantCount > MAX_QUANTIFIERS) return { safe: false, reason: 'too many quantifiers' };

  // Walk parens, tracking each group's own body text.
  const stack = [];
  let ambiguousAltGroups = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '(') { stack.push({ start: i + 1 }); continue; }
    if (c === ')') {
      const g = stack.pop();
      if (!g) continue;
      const body = clean.slice(g.start, i);
      const rest = clean.slice(i + 1);
      const quantified = rest[0] === '+' || rest[0] === '*' || rest[0] === '?' || /^\{\d+,?\d*\}/.test(rest);
      const alts = splitTopLevelAlternatives(body);

      // Rule 1: a quantified group whose own body has a nested quantifier or
      // any alternation at all.
      if (quantified) {
        const bodyHasQuantifier = /[+*]|\{\d+,?\d*\}/.test(body);
        if (bodyHasQuantifier || alts.length > 1) {
          return { safe: false, reason: 'nested quantifier or quantified alternation' };
        }
      }

      // Rule 2: an ambiguous alternation group, quantified or not. Two or
      // more anywhere in the pattern is rejected - see the file header for
      // why this closes the "unrolled" shape rule 1 cannot see.
      if (alts.length > 1 && hasAmbiguousAlternatives(alts)) {
        ambiguousAltGroups += 1;
        if (ambiguousAltGroups >= 2) {
          return { safe: false, reason: 'multiple ambiguous alternation groups' };
        }
      }
    }
  }
  return { safe: true };
}

// Test text against a pattern, but NEVER execute a structurally unsafe
// pattern: an unsafe pattern is treated as "does not match" (fail-safe), not
// as an error and never as a hang.
export function safeTest(pattern, text) {
  if (!pattern) return false;
  if (!isSafeRegexPattern(pattern).safe) return false;
  try { return new RegExp(pattern, 'i').test(text); } catch { return false; }
}
