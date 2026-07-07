import { requireUser } from './_runtime.js';

// Cancels (deletes) a pending Invitation row. Admin-gated.
export default async function cancelInvitation(ctx) {
  try {
    const caller = requireUser(ctx);
    if (caller.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    const { invitation_id } = ctx.body || {};
    if (!invitation_id) return ctx.json({ error: 'invitation_id is required' }, 400);

    await ctx.db.entities.Invitation.delete(invitation_id);
    return { ok: true };
  } catch (error) {
    if (error && typeof error.status === 'number') return ctx.json({ error: error.message }, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
