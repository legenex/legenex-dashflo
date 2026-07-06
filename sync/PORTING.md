# Function Porting Guide (Deno → Node/Express)

You are porting serverless functions from the ORIGINAL Deno source at:
`/Users/nickallen/Documents/Projects/Legenex DashOS/Reference/legenex-dashboard/base44/functions/<name>/entry.ts`

into standalone Node ESM modules at:
`/Users/nickallen/Documents/Projects/Legenex DashOS/server/src/functions/<name>.js`

## Canonical examples (READ THESE FIRST)
- `server/src/functions/health.js` — trivial
- `server/src/functions/overviewBriefing.js` — auth + LLM
- `server/src/functions/_runtime.js` — the runtime helpers (json, HttpError, requireUser)
- `server/src/lib/serverClient.js` — what `ctx.db` is
- `server/src/integrations/llm.js` — callLLM / invokeLLM (use instead of OpenAI direct)
- `server/src/config.js` — integration secrets under `config.integrations.*`

## Module shape
Each ported file default-exports one async handler:
```js
import { requireUser, HttpError } from './_runtime.js';
export default async function <name>(ctx) {
  // ctx = { body, user, db, env, config, req, json }
  ...
  return <plainObjectFor200> OR ctx.json(body, status);
}
```

## Mechanical translation table
| Deno original | Node port |
|---|---|
| `import { createClientFromRequest } from 'npm:@base44/sdk...'` | delete the import |
| `Deno.serve(async (req) => { ... })` | `export default async function name(ctx) { ... }` |
| `const base44 = createClientFromRequest(req)` | `const db = ctx.db` |
| `const user = await base44.auth.me(); if (!user) return 401` | `const user = requireUser(ctx)` (throws 401) |
| `await req.json().catch(()=>({}))` | `ctx.body` (already parsed object) |
| `new URL(req.url).searchParams.get('x')` | `ctx.req.query.x` |
| `req.method` | `ctx.req.method` |
| `Deno.env.get('X')` | `ctx.env.X` (or a `config.integrations.*` field if defined) |
| `Response.json(obj, { status })` | `return ctx.json(obj, status)` (or `return obj` for 200) |
| `new Response(body, {status})` | `return ctx.json({...}, status)` |
| `base44.entities.X` | `db.entities.X` |
| `base44.integrations.Core.InvokeLLM(a)` | `db.integrations.Core.InvokeLLM(a)` |
| `base44.asServiceRole.entities` / `base44.auth` service role | just `db.entities` (no RLS at function layer) |
| OpenAI direct `fetch(api.openai...)` | prefer `import { callLLM } from '../integrations/llm.js'` and `callLLM({prompt, system, temperature, maxTokens})` |

## Entity API available on db.entities.<Name>
`list(sort='-created_date', limit=100)`, `filter(query, sort?, limit?)`, `get(id)`,
`create(obj)`, `bulkCreate(arr)`, `update(id, patch)`, `bulkUpdate(arr)`,
`updateMany(query, { $set })`, `deleteMany(query)`, `delete(id)`, `count(query)`.
Records are flat objects: `{ id, created_date, updated_date, created_by, ...fields }`.

## Secrets / external services
- Node 18+ has global `fetch`, `crypto.subtle`, `TextEncoder`, `btoa/atob`. Keep those as-is.
- For any third-party call, read the credential from `ctx.config.integrations.<key>` first,
  falling back to `ctx.env.<ENV>`. Available config keys (see config.js):
  leadbyteApiKey/leadbyteBaseUrl, hlrApiKey/hlrBaseUrl, trustedFormApiKey, metaAccessToken,
  mercuryApiKey, stripeApiKey, xeroClientId/xeroClientSecret, googleClientEmail/googlePrivateKey,
  whatsappToken/whatsappPhoneId.
- If a required credential is missing, DO NOT crash — return
  `return ctx.json({ error: '<Provider> is not configured' }, 400)` (or `success:false`
  matching whatever shape the original returned on error, so the frontend handles it).
- Preserve the EXACT response body field names the original returns (the frontend reads them).

## Rules
- Keep all business logic identical. Only translate the platform/runtime layer.
- Keep helper functions in the same file.
- Do NOT mention base44 anywhere in the output (no comments, no strings, no imports).
- If the original imports another function's helper via `npm:` or relative Deno import, inline it.
- Use ESM `import`/`export` only.
- After writing, do a quick self-check that there are no `Deno.`, `req.json`, `createClientFromRequest`,
  or `base44` references left.
