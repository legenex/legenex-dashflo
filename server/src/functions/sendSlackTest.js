import { requireUser, HttpError } from './_runtime.js';

// One off Slack test message to a single channel. This is the same posting path
// used by the digest sender (chat.postMessage with the bot token stored in the
// IntegrationConfig entity under name "slack"), isolated here so the drawer can
// fire a real test without touching the digest function.
//
// This never writes a StateChangeEvent, never sets notified_at, and never
// enqueues a digest. It only posts one message.
export default async function sendSlackTest(ctx) {
  try {
    const user = ctx.user;
    if (!user) return ctx.json({ success: false, error: 'Unauthorized' }, 401);

    const db = ctx.db;
    const body = ctx.body || {};
    const channel = String(body.channel || '').trim();
    const text = String(body.body || '').trim();
    if (!channel) return ctx.json({ success: false, error: 'channel is required' }, 400);
    if (!text) return ctx.json({ success: false, error: 'body is required' }, 400);

    let slackToken = '';
    try {
      const cfgs = await db.entities.IntegrationConfig.filter({ name: 'slack' });
      if (cfgs[0]) {
        const parsed = JSON.parse(cfgs[0].config || '{}');
        slackToken = parsed.bot_token || parsed.access_token || '';
      }
    } catch { /* no slack config */ }

    if (!slackToken) {
      return ctx.json({ success: false, error: 'Slack is not configured. Add your Slack bot token first.' });
    }

    const apiRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${slackToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });
    const data = await apiRes.json().catch(() => ({}));
    if (apiRes.ok && data.ok) {
      return ctx.json({ success: true, ts: data.ts });
    }
    return ctx.json({ success: false, error: data.error || `HTTP ${apiRes.status}` });
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
