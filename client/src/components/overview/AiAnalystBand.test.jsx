import { describe, it, expect, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Reproduces the observed bug directly: with ANTHROPIC_API_KEY unset,
// server/src/integrations/llm.js throws `new Error('ANTHROPIC_API_KEY is not
// set')`, overviewBriefing.js catches it and returns { error: error.message }
// (see server/src/functions/overviewBriefing.js), and useAiBriefing surfaces
// that string verbatim as `error`. Before this fix AiAnalystBand rendered that
// raw string in `status-error` (red) styling, exactly matching the screenshot
// that triggered this work unit: "ANTHROPIC_API_KEY is not set" in red next to
// "Confidence 100%" and a dollar figure "at risk". CONTRACT.md section 3: a
// missing optional integration degrades quietly and never puts a red error on
// the primary dashboard.
globalThis.window = { self: {}, top: {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
globalThis.SVGElement = class SVGElement {};

const { default: AiAnalystBand } = await import('./AiAnalystBand.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

function render(props) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <AiAnalystBand
        text=""
        loading={false}
        error=""
        onRefresh={() => {}}
        confidence={80}
        riskLevel="Clear"
        riskNote="all clear"
        feedCount={10}
        {...props}
      />
    </MemoryRouter>,
  );
}

// The two static topic chips ("Buyer Risk", "Data Quality") always render in
// status-error red regardless of state, which is a separate, pre-existing
// design choice unrelated to the AI-briefing error path this work unit fixes.
// Assertions below therefore target the narrative/error region specifically
// (the exact old markup was `<div class="mt-2 text-[13px] status-error">`),
// not the word "status-error" anywhere on the page.
const OLD_RED_ERROR_LINE = /class="mt-2 text-\[13px\] status-error"/;

describe('AiAnalystBand: ANTHROPIC_API_KEY missing renders as a quiet not-configured state', () => {
  it('never renders the raw key-missing error in red status-error styling', () => {
    const html = render({ error: 'ANTHROPIC_API_KEY is not set' });
    expect(html).not.toMatch(OLD_RED_ERROR_LINE);
    expect(html).not.toContain('ANTHROPIC_API_KEY is not set');
  });

  it('renders a quiet, plain-language not-configured message with a way to fix it', () => {
    const html = render({ error: 'ANTHROPIC_API_KEY is not set' });
    expect(html).toContain('not configured');
    expect(html).toContain('href="/settings?tab=apikeys"');
  });

  it('recognizes the same failure shape for the other provider', () => {
    const html = render({ error: 'OPENAI_API_KEY is not set on this app.' });
    expect(html).not.toMatch(OLD_RED_ERROR_LINE);
    expect(html).toContain('not configured');
  });

  it('recognizes the combined failover failure message from the shared LLM client', () => {
    const html = render({
      error: 'ALL_PROVIDERS_FAILED. OpenAI: OPENAI_API_KEY is not set on this app. | Anthropic: ANTHROPIC_API_KEY is not set on this app.',
    });
    expect(html).not.toMatch(OLD_RED_ERROR_LINE);
    expect(html).toContain('not configured');
  });

  it('still surfaces a genuine runtime failure, just without alarming red styling', () => {
    const html = render({ error: 'Anthropic error 500: internal server error' });
    expect(html).not.toMatch(OLD_RED_ERROR_LINE);
    expect(html).toContain('Anthropic error 500');
    expect(html).not.toContain('not configured');
  });

  it('renders the normal narrative when there is no error', () => {
    const html = render({ text: 'Revenue is tracking to plan.', error: '' });
    expect(html).toContain('Revenue is tracking to plan.');
    expect(html).not.toContain('not configured');
  });
});

describe('AiAnalystBand: Confidence never shows a score while data quality is unavailable', () => {
  it('renders a numeric confidence percentage and its progress bar when available', () => {
    const html = render({ confidence: 87, confidenceUnavailable: false });
    expect(html).toContain('87%');
    expect(html).not.toContain('Unavailable');
  });

  it('renders "Unavailable" instead of a percentage when confidence is unavailable, even if a number was computed', () => {
    // Mirrors the observed bug: stats.dataQuality (and therefore confidence)
    // can be a false-perfect 100 with no leads behind it.
    const html = render({ confidence: 100, confidenceUnavailable: true });
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('100%');
  });
});
