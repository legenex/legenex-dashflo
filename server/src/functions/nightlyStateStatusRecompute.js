import recomputeStateStatus from './recomputeStateStatus.js';

// Nightly safety net that repairs drift between StateStatus and the underlying
// Buyer and BuyerStateCpl data.
//
// It calls the existing recomputeStateStatus once per night with
// emit_events: false. That flag is essential here: the nightly repair upserts
// StateStatus exactly as normal but writes no StateChangeEvent rows, so it can
// reconcile drift without generating a wave of supplier digests. This job must
// never send notifications for changes it merely reconciled.
//
// Scheduled once daily in the early morning of the app timezone
// (America/Regina). Returns the recompute summary. recomputeStateStatus is not
// modified; this job only invokes it.

export default async function nightlyStateStatusRecompute(ctx) {
  try {
    // Allow scheduled (no user) and admin-triggered runs only.
    const user = ctx.user;
    if (user && user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    // emit_events: false so the nightly reconcile never sends digests.
    const result = await recomputeStateStatus({
      ...ctx,
      body: { ...(ctx.body || {}), emit_events: false },
    });
    const data = result?.data !== undefined ? result.data : result;

    return { status: 'ok', recompute: data };
  } catch (error) {
    return ctx.json({ status: 'error', error: error.message }, 500);
  }
}
