// Shared runtime for ported backend functions.
//
// Each function module lives in this directory as `<name>.js` and default-exports
//   async function handler(ctx) { ... }
// where ctx = {
//   body,    // parsed JSON request body
//   user,    // authenticated user (or null)
//   db,      // server client: db.entities.X, db.auth.me(), db.integrations.Core.*
//   env,     // process.env
//   config,  // app config (integration secrets live under config.integrations)
//   req,     // raw express request
//   json,    // json(body, status) helper to control HTTP status (like Deno Response.json)
// }
// A handler returns either a plain object (-> HTTP 200) or json(body, status).

export function json(body, status = 200) {
  return { __httpResponse: true, body, status };
}

// Thrown to short-circuit with a specific status.
export class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'Error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

// Guard used by most functions: require an authenticated user.
export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, { error: 'Unauthorized' });
  return ctx.user;
}
