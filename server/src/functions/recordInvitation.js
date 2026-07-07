import { requireUser, HttpError, json } from './_runtime.js';

// Records a pending Invitation row (app-owned entity) so an invited person is
// visible in Settings > Users and Roles as "Pending" before they accept and log
// in. We track the invite in our own Invitation entity so invited people are
// visible before they accept. Admin-gated.
export default async function recordInvitation(ctx) {
  const caller = requireUser(ctx);
  if (caller.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

  try {
    const db = ctx.db;
    const { email, base_role, permissions, role } = ctx.body || {};
    if (!email) return ctx.json({ error: 'email is required' }, 400);

    // Upsert: reuse an existing pending/cancelled invite for this email.
    const existing = await db.entities.Invitation.filter({ email });
    let invitation;
    const payload = { email, role, base_role, permissions, status: 'pending', invited_by: caller.email };
    if (existing && existing[0]) {
      invitation = await db.entities.Invitation.update(existing[0].id, payload);
    } else {
      invitation = await db.entities.Invitation.create(payload);
    }

    return { invitation };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
