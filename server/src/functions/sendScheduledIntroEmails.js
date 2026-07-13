// Standalone scheduled sender for the buyer intro email from James.
//
// onboardBuyer resolves a send time and stores it on
// BuyerOnboarding.intro_email_scheduled_for. This job runs every 15 minutes,
// finds records whose scheduled time is now or in the past that have not yet
// been sent, and sends the intro email through the configured mailer.
//
// Sent state is tracked inside the existing steps array (the schema is fixed in
// this build) as a step with key intro_email_sent. A record whose steps already
// contain intro_email_sent complete is skipped so a second run never sends the
// intro email twice. On failure the step records the error and attempts, leaving
// intro_email_scheduled_for set so the next run retries; after 5 failures the
// step is marked failed so it is visible rather than looping forever.
//
// Credentials are never hardcoded and never written into a log, an error, or a
// stored record. Mail delivery is handled by the configured mailer.

import { sendMail } from '../lib/mailer.js';

const INTRO_STEP_KEY = 'intro_email_sent';
const MAX_ATTEMPTS = 5;
const PAGE_SIZE = 200;

function str(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

// Intro email subject and body, selected by the buyer's vertical. James is the
// named sender. No em dashes anywhere in these strings.
function buildIntroEmail(vertical, contactName, companyName) {
  const subjectByVertical = {
    mva: 'Getting started with your Motor Vehicle Accident leads',
    workers_comp: 'Getting started with your Workers Comp leads',
    debt: 'Getting started with your Debt leads',
  };
  const subject = subjectByVertical[vertical] || 'Getting started with Legenex';
  const body = `Hi ${contactName},\n\n`
    + `I am James, your main point of contact at Legenex. I wanted to reach out personally now that ${companyName || 'your account'} is set up.\n\n`
    + `Over the next few days we will get your first leads flowing and I will be on hand to make sure everything runs smoothly. If anything comes up, just reply to this email and it comes straight to me.\n\n`
    + `Looking forward to working with you.\n\n`
    + `Best,\nJames\nLegenex`;
  return { subject, body };
}

// Send the intro email through the configured mailer. Returns the message id.
async function sendIntroEmail(to, subject, body) {
  const info = await sendMail({ to, subject, text: body });
  const id = info && (info.messageId || info.id);
  return id ? String(id) : 'sent';
}

export default async function sendScheduledIntroEmails(ctx) {
  try {
    const db = ctx.db;

    // Allow scheduled (no user) and admin-triggered runs only.
    const user = ctx.user;
    if (user && user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    const nowIso = new Date().toISOString();

    // Candidates: intro_email_scheduled_for set and now or in the past. Page
    // through the backlog using the sort field as a cursor (the entity filter
    // exposes no offset). A seen-set dedupes the boundary record that $lte
    // re-includes on each page and guarantees the loop terminates.
    const candidates = [];
    const seen = new Set();
    let cursor = nowIso;
    while (true) {
      const batch = await db.entities.BuyerOnboarding.filter(
        { intro_email_scheduled_for: { $ne: null, $lte: cursor } },
        '-intro_email_scheduled_for',
        PAGE_SIZE,
      );
      let added = 0;
      let lastTime = null;
      for (const rec of batch) {
        if (rec && rec.intro_email_scheduled_for) lastTime = rec.intro_email_scheduled_for;
        if (rec && rec.id != null && !seen.has(rec.id)) {
          seen.add(rec.id);
          candidates.push(rec);
          added += 1;
        }
      }
      // Stop when the page was not full, when we cannot advance the cursor, or
      // when a saturated page yields nothing new.
      if (batch.length < PAGE_SIZE || !lastTime || added === 0) break;
      cursor = lastTime;
    }

    const summary = { sent: 0, skipped: 0, failed: 0 };

    for (const rec of candidates) {
      let steps = [];
      try {
        steps = typeof rec.steps === 'string' ? JSON.parse(rec.steps || '[]') : (rec.steps || []);
      } catch { steps = []; }
      if (!Array.isArray(steps)) steps = [];

      const introStep = steps.find((s) => s && s.key === INTRO_STEP_KEY);

      // Already sent: skip so we never send twice.
      if (introStep && introStep.status === 'complete') {
        summary.skipped += 1;
        continue;
      }
      // Already capped out at max attempts and marked failed: leave it visible.
      if (introStep && introStep.status === 'failed') {
        summary.skipped += 1;
        continue;
      }

      let payload = {};
      try {
        payload = typeof rec.form_payload === 'string' ? JSON.parse(rec.form_payload || '{}') : (rec.form_payload || {});
      } catch { payload = {}; }

      // Resolve recipient and vertical from the buyer record when present, else
      // fall back to the raw form payload.
      let buyer = null;
      if (rec.buyer_id) {
        buyer = await db.entities.Buyer.get(rec.buyer_id).catch(() => null);
      }
      const to = str(payload.primary_contact_email) || str(buyer?.email);
      const vertical = str(buyer?.vertical) || str(payload.vertical);
      const contactName = (str(payload.primary_contact_name).split(' ')[0]) || 'there';
      const companyName = str(payload.company_name) || str(buyer?.company_name) || str(rec.company_name);

      const priorAttempts = introStep ? (Number(introStep.attempts) || 0) : 0;

      const writeStep = (patch) => {
        const next = steps.filter((s) => !(s && s.key === INTRO_STEP_KEY));
        next.push({
          key: INTRO_STEP_KEY,
          status: patch.status,
          attempts: patch.attempts,
          error: patch.error ?? null,
          external_id: patch.external_id ?? null,
          completed_at: patch.completed_at ?? null,
        });
        steps = next;
      };

      if (!to) {
        // No recipient: this can never succeed. Record the reason and count it
        // against the attempt cap so it does not loop forever.
        const attempts = priorAttempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        writeStep({ status: failed ? 'failed' : 'pending', attempts, error: 'No recipient email on the onboarding record.' });
        await db.entities.BuyerOnboarding.update(rec.id, { steps: JSON.stringify(steps) }).catch(() => {});
        summary.failed += 1;
        continue;
      }

      try {
        const { subject, body } = buildIntroEmail(vertical, contactName, companyName);
        const messageId = await sendIntroEmail(to, subject, body);
        writeStep({
          status: 'complete',
          attempts: priorAttempts + 1,
          error: null,
          external_id: messageId,
          completed_at: new Date().toISOString(),
        });
        await db.entities.BuyerOnboarding.update(rec.id, { steps: JSON.stringify(steps) });
        summary.sent += 1;
      } catch (err) {
        const attempts = priorAttempts + 1;
        const capped = attempts >= MAX_ATTEMPTS;
        // Record the error on the step. Leave intro_email_scheduled_for set so a
        // non-capped failure retries next run. After the cap, mark failed.
        writeStep({
          status: capped ? 'failed' : 'pending',
          attempts,
          error: err.message,
        });
        await db.entities.BuyerOnboarding.update(rec.id, { steps: JSON.stringify(steps) }).catch(() => {});
        summary.failed += 1;
      }
    }

    return { status: 'ok', ...summary, processed: candidates.length };
  } catch (error) {
    return ctx.json({ status: 'error', error: error.message }, 500);
  }
}
