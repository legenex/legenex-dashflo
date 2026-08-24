// Configure Walker Advertising's native SubDelivery from the reference
// screenshots supplied for the Stage 2 Lead Distribution rebuild.
//
// Usage:
//   node scripts/configure-walker-native-delivery.js            report only
//   node scripts/configure-walker-native-delivery.js --apply    write it
//
// SAFETY: this only ever writes to the existing SubDelivery row(s) under
// Walker's existing Delivery ("Walker - 30 Days", status draft, confirmed by
// the Stage 1/2 audit against a local mirror of production data). It never
// changes Delivery.status, never creates or touches a RouteGroup/RouteMember,
// and never activates anything. Walker stays Draft/inactive after this runs,
// exactly as required - this only populates the endpoint configuration so it
// is visible and editable in the canonical delivery editor and testable via
// Dry Run / Mock Send, not so it can send a real lead.
//
// This has NOT been run against production from the coding session that
// wrote it: production's database lives on the VPS and this session has no
// credential or SSH path to it (see AGENTS.md section 15). It is written to
// run safely against whatever DATABASE_URL / PG* the environment it's
// invoked in points at - local dev today, production once someone with
// production database access runs it, or the operator can reach the same
// end state by hand through /webhooks or Operations > Buyers > Walker
// Advertising, since both write the identical SubDelivery record.
//
// PROVENANCE of every field below is stated explicitly. Nothing here is
// invented: values are either read directly off the supplied screenshots, or
// carried over unchanged from the existing SubDelivery row, or explicitly
// left blank with a stated reason. See the WALKER_CONFIG object.

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';

const APPLY = process.argv.includes('--apply');

// --- Reference screenshot 3 (current DashFlo "DELIVERY METHODS" draft for
// Walker) is the clearest, most directly applicable source: it already shows
// the real target endpoint, format, and one non-secret header, plus four
// legible body fields the operator had begun entering.
const CONFIRMED_TARGET_URL = 'https://walkeradvertising.leadportal.com/apiJSON.php';
const CONFIRMED_HEADERS = { 'X-Env': 'prod' };

// The four fields legible in that same draft screenshot, converted from its
// [bracket] placeholder syntax to DashFlo's real {{token}} syntax (confirmed
// against TokenReferencePanel / payloadTemplate.js's resolveTokenValue -
// "treatment", "type_of_injury", and "incident_date" are all recognized
// tokens). "Have_Attorney": "No" was typed as a literal, not a token, in the
// source screenshot; it is carried over as a literal here rather than
// guessed into a token, per the instruction to mark rather than invent.
const CONFIRMED_BODY_FIELDS = {
  Medical_Treatment: '{{treatment}}',
  Have_Attorney: 'No', // literal in the source draft, not a token - confirm with operator whether this should stay fixed
  Type_Of_Injury: '{{type_of_injury}}',
  Incident_Date: '{{incident_date}}',
};

// Standard contact/case fields, by analogy to the existing default
// LeadByteConnector's own payload_template for the same MVA vertical
// (LGNX-LEGAL-MVA, target legenex.leadbyte.co) - NOT read off a
// Walker-specific screenshot, since Walker's own screenshots did not show a
// full contact-field body. Included because a lead payload with no name,
// phone, or email is not a usable lead for any buyer in this vertical. Flag
// this set for operator confirmation before Walker goes live.
const INFERRED_BY_ANALOGY_FIELDS = {
  campid: 'LEGAL-MVA-USA',
  sid: '{{sid}}',
  ssid: '{{ssid}}',
  firstname: '{{first_name}}',
  lastname: '{{last_name}}',
  phone1: '{{mobile}}',
  email: '{{email}}',
  ip_address: '{{ip_address}}',
  zip: '{{zip}}',
  accident_state: '{{accident_state}}',
  accident_date: '{{incident_date_2}}',
  trustedform_url: '{{trustedform_url}}',
};

const PAYLOAD_TEMPLATE = JSON.stringify(
  { ...INFERRED_BY_ANALOGY_FIELDS, ...CONFIRMED_BODY_FIELDS },
  null, 2,
);

// Response shape: NOT populated. The LeadByte-mediated reference screenshot
// (Remote System Response: Match by Exact, an XML-shaped <response><status>
// pattern) describes DashFlo's existing connection to the LeadByte platform,
// not a response ever observed from Walker's own apiJSON.php endpoint -
// DashFlo has never posted there directly. Assuming Walker's native endpoint
// returns the same XML-ish shape as an unrelated system would be a guess, not
// a read fact, so response_mapping is deliberately left unset here. Populate
// it from a real observed response before relying on automatic
// accept/reject classification for Walker.
const RESPONSE_MAPPING = null;

// Schedule and caps: the LeadByte-mediated reference showed every day
// 00:00-23:59 (fully open) and every cap field at 0. schedule.js's own
// contract treats "no windows" as always-on, so a fully-open schedule and an
// omitted schedule are equivalent - nothing is lost by leaving it unset. A
// cap value of 0 in that reference UI is ambiguous (blank/unset vs a real
// zero-lead cap in a different convention), so per the instruction not to
// invent numbers, caps are left unset rather than guessed.
const SCHEDULE_JSON = null;
const CAPS_JSON = null;

async function main() {
  await ensureSchema();
  const Buyer = repo('Buyer');
  const Delivery = repo('Delivery');
  const SubDelivery = repo('SubDelivery');

  const buyers = await Buyer.list('-created_date', 1000);
  const walker = buyers.find((b) => b.buyer_code === 'AG1' || b.company_name === 'Walker Advertising');
  if (!walker) {
    console.log('[configure-walker] No Buyer found with buyer_code AG1 / company_name "Walker Advertising". Nothing to do.');
    await pool.end();
    return;
  }
  console.log(`[configure-walker] Buyer: ${walker.company_name} (id ${walker.id}, buyer_code ${walker.buyer_code})`);

  const deliveries = await Delivery.list('-created_date', 1000);
  const walkerDeliveries = deliveries.filter((d) => String(d.buyer_id) === String(walker.id));
  if (walkerDeliveries.length === 0) {
    console.log('[configure-walker] No existing Delivery found for this buyer. Refusing to create one blind - '
      + 'create it once through the canonical editor (/webhooks or Operations > Buyers > Walker Advertising) so a '
      + 'human names it and sets its vertical, then re-run this script to populate the endpoint.');
    await pool.end();
    return;
  }

  const subs = await SubDelivery.list('-created_date', 1000);
  let touched = 0;
  for (const delivery of walkerDeliveries) {
    const mine = subs.filter((s) => String(s.delivery_id) === String(delivery.id));
    console.log(`[configure-walker] Delivery "${delivery.name}" (id ${delivery.id}, status ${delivery.status}) has ${mine.length} SubDelivery row(s).`);
    for (const sub of mine) {
      const patch = {
        target_url: CONFIRMED_TARGET_URL,
        headers: JSON.stringify(CONFIRMED_HEADERS),
        encoding: 'json',
        method: 'POST',
        payload_template: PAYLOAD_TEMPLATE,
      };
      if (RESPONSE_MAPPING) patch.response_mapping = JSON.stringify(RESPONSE_MAPPING);
      if (SCHEDULE_JSON) patch.schedule = JSON.stringify(SCHEDULE_JSON);
      if (CAPS_JSON) patch.caps = JSON.stringify(CAPS_JSON);

      console.log(`  SubDelivery ${sub.id} ("${sub.name}"):`);
      console.log(`    target_url  -> ${patch.target_url}`);
      console.log(`    headers     -> ${patch.headers}`);
      console.log(`    payload_template (${Object.keys({ ...INFERRED_BY_ANALOGY_FIELDS, ...CONFIRMED_BODY_FIELDS }).length} fields, see script source for provenance)`);
      console.log('    response_mapping -> left unset (no real Walker response observed yet)');
      console.log('    schedule / caps  -> left unset (ambiguous in the source reference; do not invent)');

      if (APPLY) {
        await SubDelivery.update(sub.id, patch);
        console.log('    APPLIED');
        touched += 1;
      }
    }
  }

  if (!APPLY) {
    console.log(`\n[configure-walker] Report only. Re-run with --apply to write ${subs.filter((s) => walkerDeliveries.some((d) => String(d.id) === String(s.delivery_id))).length} SubDelivery row(s).`);
  } else {
    console.log(`\n[configure-walker] Applied to ${touched} SubDelivery row(s). Delivery.status was NOT changed - it stays wherever it already was (draft), so this remains inert until an operator activates it.`);
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
