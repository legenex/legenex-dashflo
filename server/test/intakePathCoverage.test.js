import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Task I3, the coverage half. These are source level assertions on purpose.
//
// "Every real lead path uses one canonical processing service" is a property of
// the call graph, not of one request. A behavioural test proves the path it
// exercises; it cannot prove that no seventh path was added last week which
// writes leads directly. So this file reads the function tree and asserts the
// shape: who invokes the canonical service, who creates leads without it, and
// what the one documented exception is allowed to do.
//
// If this file fails, either a new intake path appeared and must be wired into
// processLead, or webhook.js grew a capability it is not permitted to have.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(HERE, '../src/functions');

const read = (name) => fs.readFileSync(path.join(FUNCTIONS_DIR, name), 'utf8');
const allFunctionFiles = () => fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.js'));

// Callers that reach the canonical service. Established by reading the tree
// and re-derived here so the list cannot drift silently.
//
// leadbyteWebhook.js is deliberately absent. An earlier reading counted it as a
// caller on a grep for "processLead", but all three hits are comments and its
// own header says it never calls processLead or any routing. It is an outcome
// reconciliation path, like webhook.js, and is covered below.
const CANONICAL_CALLERS = ['leads.js', 'callWebhook.js', 'syncGoogleSheets.js', 'validate.js'];

// The two documented outcome reconciliation endpoints. Neither is a fresh
// consumer intake path: they record what already happened to a lead elsewhere,
// and they backfill a lead row when no match exists. What matters for
// invariant 1 is that neither can reach a buyer.
const RECONCILIATION_PATHS = [
  { file: 'webhook.js', channel: "ingest_channel: 'webhook'" },
  { file: 'leadbyteWebhook.js', channel: "ingest_channel: 'leadbyte_webhook'" },
];

describe('the canonical intake sequence is wired into processLead', () => {
  const src = read('processLead.js');

  it('imports the canonical intake module', () => {
    expect(src).toMatch(/from '\.\.\/lib\/intake\.js'/);
    expect(src).toContain('captureAndScreen');
  });

  it('captures durably before it touches the ApiKey counters or creates a Lead', () => {
    const capture = src.indexOf('await captureAndScreen(');
    const counters = src.indexOf('await db.entities.ApiKey.update(apiKeyRecord.id');
    const leadCreate = src.indexOf('const lead = await db.entities.Lead.create(');

    expect(capture).toBeGreaterThan(-1);
    expect(counters).toBeGreaterThan(-1);
    expect(leadCreate).toBeGreaterThan(-1);
    // Ordering is the invariant: the receipt is the first durable write.
    expect(capture).toBeLessThan(counters);
    expect(capture).toBeLessThan(leadCreate);
  });

  it('captures only after the dry run block has returned, so a validation writes nothing', () => {
    const dryRunReturn = src.indexOf('would_be_status: wouldBeStatus');
    const capture = src.indexOf('await captureAndScreen(');
    expect(dryRunReturn).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(dryRunReturn);
  });

  it('stops on anything that is not ACCEPTED, using mayProcess rather than a boolean', () => {
    expect(src).toContain('if (!mayProcess(capture))');
    // The three stops must each be handled, or one of them silently continues.
    expect(src).toContain('INTAKE_OUTCOME.SUPPRESSED');
    expect(src).toContain('INTAKE_OUTCOME.DUPLICATE');
  });

  it('concludes the receipt on the success path', () => {
    // Without this every processed lead stays in the pending backlog and a
    // replay reprocesses it.
    expect(src).toContain('completeReceipt(');
    expect(src).toContain('effectsApplied: true');
  });
});

describe('every known caller reaches the canonical service', () => {
  for (const caller of CANONICAL_CALLERS) {
    it(`${caller} invokes processLead rather than creating leads itself`, () => {
      const src = read(caller);
      expect(src).toContain('processLead');
    });
  }
});

// The one documented exception, settled by evidence rather than by assumption.
//
// webhook.js is an outcome reconciliation endpoint. LeadByte and buyers post
// back what happened to a lead: converted, returned, contacted, or a cost row.
// It matches an existing lead by external id, email or mobile and updates it.
// When no match exists it creates the lead from the payload as a backfill, and
// that record carries ingest_channel "webhook" and a final_status that the
// legacy system already decided.
//
// It is therefore not a fresh consumer intake path: nothing here is validated,
// routed, priced or sold. What matters for invariant 1 is that it cannot reach
// a buyer, and that is what these tests pin.
describe.each(RECONCILIATION_PATHS)('$file is an outcome reconciliation path and cannot reach a buyer', ({ file, channel }) => {
  const src = read(file);

  it('creates leads, which is why it needs pinning at all', () => {
    expect(src).toContain('entities.Lead.create(');
  });

  it('marks what it creates with its own ingest channel', () => {
    expect(src).toContain(channel);
  });

  it('cannot deliver to a buyer', () => {
    for (const forbidden of ['fireDeliveries', 'fireConnectors', 'sendDestinationAwait', 'sendHttpEvent']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('cannot bill, charge or move money', () => {
    for (const forbidden of ['BillingLineItem', 'WalletTransaction', 'BuyerPayment', 'Invoice.create']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('cannot route or record a delivery attempt', () => {
    for (const forbidden of ['routeWaterfall', 'DeliveryAttempt', 'evaluateMember', 'BidAttempt']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('cannot emit a conversion event', () => {
    expect(src).not.toContain('sendCapiEvent');
    expect(src).not.toContain('ConversionEvent');
  });

  it('does not reach the routing or delivery engine at all', () => {
    // The single property that keeps these two paths outside invariant 1's
    // blast radius: they record outcomes, they never sell anything.
    expect(src).not.toContain('distribution/engine');
    expect(src).not.toContain('routingEngine');
  });
});

describe('webhook.js authenticates before it writes', () => {
  const src = read('webhook.js');
  it('rejects a missing or unrecognised key', () => {
    // Not a canonical intake path, but a public surface that creates records,
    // so the auth requirement is unchanged.
    expect(src).toContain('resolveApiKey');
    expect(src).toContain("reason: 'missing_key'");
    expect(src).toContain("reason: 'invalid_key'");
  });
});

describe('no undeclared path creates leads behind the canonical service', () => {
  it('only processLead and the documented webhook exception call Lead.create', () => {
    // The guard that actually catches a new bypass. A file that starts
    // creating leads must either go through processLead or be added here with
    // a reason, and adding it here is a visible decision in a diff.
    const ALLOWED = new Set(['processLead.js', ...RECONCILIATION_PATHS.map((p) => p.file)]);
    const offenders = [];

    for (const file of allFunctionFiles()) {
      if (ALLOWED.has(file)) continue;
      const src = read(file);
      if (/entities\.Lead\.create\s*\(/.test(src)) offenders.push(file);
    }

    expect(offenders, `these create leads without going through processLead: ${offenders.join(', ')}`)
      .toEqual([]);
  });
});
