import { requireUser } from './_runtime.js';

// Creates or updates a User record for an invited email, so invited users appear
// immediately in Settings Users and Roles (custom auth otherwise only creates a
// pending invitation until the user logs in).
// Admin-gated: only admins may provision users.
export default async function upsertInvitedUser(ctx) {
  const caller = requireUser(ctx);
  if (caller.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

  const db = ctx.db;
  try {
    const { email, base_role, permissions, role } = ctx.body || {};
    if (!email) return ctx.json({ error: 'email is required' }, 400);

    const existing = await db.entities.User.filter({ email });
    let user;
    if (existing && existing[0]) {
      user = await db.entities.User.update(existing[0].id, {
        role,
        base_role,
        permissions,
      });
    } else {
      const fullName = String(email).split('@')[0];
      user = await db.entities.User.create({
        email,
        full_name: fullName,
        role,
        base_role,
        permissions,
      });
    }

    return { user };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
