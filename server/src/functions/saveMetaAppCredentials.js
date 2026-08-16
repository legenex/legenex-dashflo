import systemKeys from './systemKeys.js';

// Compatibility endpoint for the existing client wrapper. Meta application
// credentials are now owner-only and write exclusively to SystemKey.
export default async function saveMetaAppCredentials(ctx) {
  return systemKeys({ ...ctx, body: { ...(ctx.body || {}), op: 'system_meta_save' } });
}
