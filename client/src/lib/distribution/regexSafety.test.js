import { describe, it, expect } from 'vitest';
import { isSafeRegexPattern, safeTest } from './regexSafety.js';

describe('isSafeRegexPattern', () => {
  it('accepts an empty/absent pattern', () => {
    expect(isSafeRegexPattern('').safe).toBe(true);
    expect(isSafeRegexPattern(undefined).safe).toBe(true);
    expect(isSafeRegexPattern(null).safe).toBe(true);
  });

  it('accepts ordinary operator patterns', () => {
    expect(isSafeRegexPattern('accepted').safe).toBe(true);
    expect(isSafeRegexPattern('^(ok|accepted|success)$').safe).toBe(true);
    expect(isSafeRegexPattern('lead[_-]?id\\s*:\\s*\\d+').safe).toBe(true);
    expect(isSafeRegexPattern('status":"(ACCEPTED|SOLD)"').safe).toBe(true);
  });

  it('rejects the canonical nested-quantifier catastrophic patterns', () => {
    expect(isSafeRegexPattern('(a+)+b').safe).toBe(false);
    expect(isSafeRegexPattern('(a*)*b').safe).toBe(false);
    expect(isSafeRegexPattern('(a+)*b').safe).toBe(false);
    expect(isSafeRegexPattern('([a-zA-Z]+)*$').safe).toBe(false);
  });

  it('rejects a quantified alternation of overlapping options', () => {
    expect(isSafeRegexPattern('(a|a)+').safe).toBe(false);
    expect(isSafeRegexPattern('(a|ab)*c').safe).toBe(false);
  });

  // Regression: an adversarial review found the FIRST version of this
  // detector missed "unrolled" catastrophic patterns - a sequence of
  // ambiguous alternation groups with NO quantifier anywhere at all. Verified
  // to actually freeze safeTest for 50+ seconds against this exact pattern
  // before the fix. Rule 1 (quantified group containing alternation) cannot
  // see this shape since no group here is individually quantified; rule 2
  // (2+ ambiguous alternation groups anywhere) is what catches it.
  it('rejects an unrolled sequence of ambiguous alternation groups with no quantifier anywhere', () => {
    const pattern = `^${'(a|aa)'.repeat(32)}c$`;
    expect(isSafeRegexPattern(pattern).safe).toBe(false);
  });

  it('does not flag a single ambiguous alternation group used once, or multiple non-ambiguous groups', () => {
    expect(isSafeRegexPattern('(a|aa)b').safe).toBe(true); // one ambiguous group alone: O(2), not exponential
    expect(isSafeRegexPattern('(cat|dog)(red|blue)').safe).toBe(true); // two groups, neither ambiguous
  });

  it('rejects an overlong pattern', () => {
    expect(isSafeRegexPattern('a'.repeat(500)).safe).toBe(false);
  });

  it('rejects a pattern with excessive quantifier count', () => {
    expect(isSafeRegexPattern('a+b+c+d+e+f+g+h+i+j+k+l+m+n+').safe).toBe(false);
  });

  it('does not mistake an escaped metacharacter for a live one', () => {
    expect(isSafeRegexPattern('\\(a\\+\\)\\+b').safe).toBe(true);
  });
});

describe('safeTest', () => {
  it('matches normally for a safe pattern', () => {
    expect(safeTest('accepted', 'the lead was accepted')).toBe(true);
    expect(safeTest('rejected', 'the lead was accepted')).toBe(false);
  });

  it('never executes an unsafe pattern, and completes instantly against an adversarial input', () => {
    const adversarialInput = 'a'.repeat(40) + '!';
    const start = Date.now();
    const result = safeTest('(a+)+b', adversarialInput);
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBe(false);
  });

  // Regression: the exact adversarial-review reproduction that froze the
  // FIRST version of this detector for 50+ seconds against an ORDINARY
  // (non-adversarially-crafted) 52-character body.
  it('completes instantly for the unrolled-alternation shape against an ordinary body', () => {
    const pattern = `^${'(a|aa)'.repeat(32)}c$`;
    const start = Date.now();
    const result = safeTest(pattern, 'a'.repeat(52));
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBe(false);
  });
});
