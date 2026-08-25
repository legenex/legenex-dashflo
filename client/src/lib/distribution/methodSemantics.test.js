import { describe, it, expect } from 'vitest';
import { methodSendsBody } from './methodSemantics.js';

// This is the exact decision both directPost.js's real send path and
// DeliveryEditorPage.jsx's tab rendering evaluate - see directPost.test.js's
// "method-aware request semantics" suite for the wire-level proof that the
// real request matches what this function says. Covered here in isolation so
// the decision itself, independent of the network, is pinned.
describe('methodSendsBody', () => {
  it('GET never sends a body, regardless of delete_with_body', () => {
    expect(methodSendsBody('GET', false)).toBe(false);
    expect(methodSendsBody('GET', true)).toBe(false);
  });

  it('DELETE sends a body only when explicitly opted in', () => {
    expect(methodSendsBody('DELETE', false)).toBe(false);
    expect(methodSendsBody('DELETE', undefined)).toBe(false);
    expect(methodSendsBody('DELETE', true)).toBe(true);
  });

  it('POST, PUT, PATCH always send a body', () => {
    for (const m of ['POST', 'PUT', 'PATCH']) {
      expect(methodSendsBody(m, false)).toBe(true);
      expect(methodSendsBody(m, true)).toBe(true);
    }
  });

  it('is case-insensitive and defaults an unset method to POST-like (sends a body)', () => {
    expect(methodSendsBody('get', false)).toBe(false);
    expect(methodSendsBody('delete', true)).toBe(true);
    expect(methodSendsBody(undefined, false)).toBe(true);
  });
});
