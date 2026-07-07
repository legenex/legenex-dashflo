import { requireUser } from './_runtime.js';

// Returns every User record for this app, bypassing the per-caller row-level
// security that normally scopes a User listing to the requesting user.
// Admin-gated: only admins may enumerate all users.
export default async function listUsers(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

  try {
    const db = ctx.db;

    const all = await db.entities.User.list();
    const users = (all || []).map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      base_role: u.base_role,
      permissions: u.permissions,
      created_date: u.created_date,
      linked_buyer_id: u.linked_buyer_id,
      linked_supplier_id: u.linked_supplier_id,
      status: 'active',
    }));

    // Merge pending invitations: anyone invited but not yet a real User shows as
    // "pending". Skip invites whose email already has a User record (they joined).
    const existingEmails = new Set(users.map((u) => (u.email || '').toLowerCase()));
    let pending = [];
    try {
      const invites = await db.entities.Invitation.filter({ status: 'pending' });
      pending = (invites || [])
        .filter((inv) => inv.email && !existingEmails.has(inv.email.toLowerCase()))
        .map((inv) => ({
          id: `invite_${inv.id}`,
          invitation_id: inv.id,
          full_name: null,
          email: inv.email,
          role: inv.role,
          base_role: inv.base_role,
          permissions: inv.permissions,
          created_date: inv.created_date,
          status: 'pending',
        }));
    } catch {
      // Invitation entity may not exist yet — ignore.
    }

    return { users: [...users, ...pending] };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
