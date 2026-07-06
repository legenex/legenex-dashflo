import { requireUser } from './_runtime.js';

// Returns every User record for this app, bypassing the row-level scoping that
// limits a normal User.list() to the caller. Admin-gated: only admins may
// enumerate all users.
export default async function listUsers(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

  const db = ctx.db;
  try {
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
    }));

    return { users };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
