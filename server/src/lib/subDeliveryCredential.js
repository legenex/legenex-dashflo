// Resolve an opaque SubDelivery credential_ref into real auth headers, server
// side, at send time. The secret never enters a snapshot, a trace, an operator
// response, or anything browser-facing. Returns {} when the secret store holds
// nothing for the ref, so a misconfigured destination fails as an unauthenticated
// rejection rather than leaking or crashing the pipeline.
//
// Convention: a delivery credential is an IntegrationConfig row keyed by `name`
// (matching SubDelivery.credential_ref exactly) whose config JSON holds a
// `token` field - the literal value to send as the Authorization header. `token`
// is deliberately named to match integrationConfig.js's SECRET_KEY_PATTERNS, so
// projectConfig()/integrationConfigStatus.js never return its value to a client,
// only presence. Created/edited through the existing admin-only
// saveIntegrationConfig function; listCredentialReferences.js exposes names only.
//
// Shared by every real/adjacent send path (processLead.js, nativeRetryRunner.js,
// campaignDeliveryTest.js) so a credential_ref resolves identically everywhere,
// the same one-shared-translation pattern already used for response mapping
// (see deliveryAttempt.js's toClassifyResponseMapping).
//
// Previously each of the three call sites hand-rolled its own version, all
// filtering IntegrationConfig by a `key` field and reading `.value` off the row
// directly - neither of which exists on the real schema (`name` + a JSON
// `config` string, see IntegrationConfig.json and integrationConfig.js). Every
// credential_ref has therefore always resolved to {}, silently sending outbound
// requests unauthenticated regardless of what an operator configured.
import { parseConfig } from './integrationConfig.js';

export async function resolveSubDeliveryCredential(db, ref) {
  if (!ref) return {};
  try {
    const rows = await db.entities.IntegrationConfig.filter({ name: ref });
    const record = rows && rows[0];
    if (!record) return {};
    const { config } = parseConfig(record.config);
    const val = config && typeof config.token === 'string' ? config.token : null;
    if (val) return { Authorization: val };
  } catch { /* secret store not configured in this environment */ }
  return {};
}
