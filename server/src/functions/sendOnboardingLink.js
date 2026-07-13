import { requireUser, HttpError } from './_runtime.js';
import { sendMail } from '../lib/mailer.js';

// Email a per-buyer onboarding link to the buyer contact. Operator only.
// Returns JSON only and never logs secrets.
//
// Access rules:
// - Must be an authenticated session.
// - Rejected if base_role is supplier or buyer, or if linked_buyer_id /
//   linked_supplier_id is set (those are portal accounts, not operators).
// - Must have at least one operator permission set true, or role admin.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

const ACTIVE_ONBOARDING_STATUSES = ['invited', 'submitted', 'in_progress', 'blocked'];

export default async function sendOnboardingLink(ctx) {
  try {
    const db = ctx.db;

    const user = requireUser(ctx);

    const record = await db.entities.User.get(user.id).catch(() => null);
    const caller = record || user;

    if (caller.base_role === 'supplier' || caller.base_role === 'buyer') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }
    if (caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }
    const hasOperatorPermission = OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
    if (!hasOperatorPermission && caller.role !== 'admin') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    const body = ctx.body || {};
    const buyerId = body.buyer_id;
    const linkBase = body.link_base;
    if (!buyerId || !linkBase) {
      return ctx.json({ error: 'buyer_id and link_base are required' }, 400);
    }

    const buyer = await db.entities.Buyer.get(buyerId).catch(() => null);
    if (!buyer) return ctx.json({ error: 'Buyer not found' }, 404);

    const list = await db.entities.BuyerOnboarding.filter({ buyer_id: buyerId });
    const onboarding = (Array.isArray(list) ? list : [])
      .find((o) => ACTIVE_ONBOARDING_STATUSES.includes(o.status));
    if (!onboarding) {
      return ctx.json({ error: 'No onboarding link for this buyer. Generate it first.' }, 404);
    }

    const to = buyer.email;
    if (!to) {
      return ctx.json({ error: 'This buyer has no contact email.' }, 400);
    }

    const link = `${linkBase}/apply?token=${onboarding.token}`;

    const tplList = await db.entities.OnboardingEmailTemplate.filter({ event: 'invite' });
    const tpl = (Array.isArray(tplList) ? tplList : [])[0] || null;
    const vars = {
      company_name: buyer.company_name || '',
      contact_name: 'there',
      buyer_code: buyer.buyer_code || '',
      vertical: buyer.vertical || '',
      link,
    };
    const renderTpl = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k]) : ''));
    const subject = tpl && tpl.subject
      ? renderTpl(tpl.subject)
      : ('Complete your Legenex onboarding' + (buyer.company_name ? ' - ' + buyer.company_name : ''));
    const body_text = tpl && tpl.body
      ? renderTpl(tpl.body)
      : `Hi,\n\nPlease complete your onboarding for ${buyer.company_name || 'your account'} using the secure link below. Your vertical and account details are already set up, so you only need to fill in the remaining information.\n\n${link}\n\nThank you,\nThe Legenex Team`;

    await sendMail({ to, subject, body: body_text });

    const link_sent_at = new Date().toISOString();
    await db.entities.BuyerOnboarding.update(onboarding.id, { link_sent_at });

    return ctx.json({ ok: true, link_sent_at, to });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
