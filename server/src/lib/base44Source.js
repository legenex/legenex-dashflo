// Read-only HTTP client for the Base44 `migrateSource` function.
//
// This is the only way DashFlo talks to Base44, and it is deliberately small.
//
// Why this endpoint and not the entities REST API
// -----------------------------------------------
// The Base44 entities REST API applies row level security to the caller. Once
// the credential bearing entities were locked to admin reads, an anonymous
// server side pull returns an empty array rather than an error, which is the
// worst possible failure mode for a migration: it looks like success and it
// means "delete everything". `migrateSource` runs asServiceRole behind a shared
// secret, so it either authenticates and returns real rows or it returns 403.
//
// Why not an agent
// ----------------
// The previous mechanism shelled out to `claude -p` with the Base44 MCP
// connector. That connector is bound to a human's account, so it cannot run on
// the server, and a language model is not a deterministic ETL transport. This
// is plain HTTPS with timeouts and bounded retries.
//
// Secret handling
// ---------------
// The secret is read from the environment and is never logged, never included
// in an error message, and never returned to a caller. `describe()` exists so
// diagnostics can report the configured host without touching the credential.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const MAX_PAGE = 500;

// Retry only on transport failures and the server side status codes that are
// genuinely transient. A 403 is a bad secret and a 400 is a bad request; both
// are permanent and retrying them just multiplies the damage.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class Base44SourceError extends Error {
  constructor(message, { status = null, retryable = false, entity = null, notInSource = false } = {}) {
    super(message);
    this.name = 'Base44SourceError';
    this.status = status;
    this.retryable = retryable;
    this.entity = entity;
    // The entity does not exist in Base44 at all. DashFlo has entities the old
    // app never had, so this is a normal state, not a sync failure.
    this.notInSource = notInSource;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function base44ConfigFromEnv(env = process.env) {
  const appId = String(env.BASE44_APP_ID || '').trim();
  const secret = String(env.BASE44_MIGRATE_SECRET || '').trim();
  const baseUrl = String(
    env.BASE44_BASE_URL || (appId ? `https://${appId}.base44.app` : ''),
  ).replace(/\/+$/, '');

  return {
    appId,
    secret,
    baseUrl,
    functionUrl: appId && baseUrl ? `${baseUrl}/api/apps/${appId}/functions/migrateSource` : '',
    timeoutMs: Number(env.BASE44_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    retries: Number(env.BASE44_RETRIES) || DEFAULT_RETRIES,
    // Absent or explicitly off means the scheduled sync does nothing. After
    // cutover this is the single switch that retires the Base44 dependency.
    enabled: !/^(0|false|no|off)?$/i.test(String(env.BASE44_SYNC_ENABLED ?? '').trim()),
  };
}

export function isConfigured(cfg) {
  return Boolean(cfg && cfg.appId && cfg.secret && cfg.functionUrl);
}

export class Base44Source {
  constructor(cfg = base44ConfigFromEnv(), { fetchImpl = globalThis.fetch } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  // Safe to log. Deliberately reports only whether a secret is present.
  describe() {
    return {
      appId: this.cfg.appId || null,
      functionUrl: this.cfg.functionUrl || null,
      secretConfigured: Boolean(this.cfg.secret),
      enabled: Boolean(this.cfg.enabled),
    };
  }

  async #call(body, { entity = null } = {}) {
    if (!isConfigured(this.cfg)) {
      throw new Base44SourceError(
        'Base44 source is not configured. Set BASE44_APP_ID and BASE44_MIGRATE_SECRET.',
        { retryable: false, entity },
      );
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const res = await this.fetchImpl(this.cfg.functionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, secret: this.cfg.secret }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // The body has to be inspected even on a 5xx. Base44 answers "entity
          // schema not found" with a 500, and that is a permanent, expected
          // condition for a DashFlo-native entity. Treating it as a transient
          // 500 would retry three times and then report a hard failure for
          // something that is simply not in the source app.
          const detail = await res.json().catch(() => null);
          const message = detail && detail.error ? String(detail.error) : '';
          const notInSource = /not found in app|unknown entity/i.test(message);
          const retryable = !notInSource && RETRYABLE_STATUS.has(res.status);

          lastError = new Base44SourceError(
            message
              ? `Base44 migrateSource error (HTTP ${res.status}): ${message}`
              : `Base44 migrateSource returned HTTP ${res.status}`,
            { status: res.status, retryable, entity, notInSource },
          );
          if (!retryable) throw lastError;
        } else {
          const json = await res.json();
          if (json && json.error) {
            throw new Base44SourceError(`Base44 migrateSource error: ${json.error}`, {
              status: res.status,
              retryable: false,
              entity,
              notInSource: /not found in app|unknown entity/i.test(String(json.error)),
            });
          }
          return json;
        }
      } catch (err) {
        if (err instanceof Base44SourceError && !err.retryable) throw err;
        lastError = err instanceof Base44SourceError
          ? err
          : new Base44SourceError(
            err?.name === 'AbortError'
              ? `Base44 request timed out after ${this.cfg.timeoutMs}ms`
              : `Base44 request failed: ${err?.message || 'unknown transport error'}`,
            { retryable: true, entity },
          );
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.cfg.retries) {
        await sleep(Math.min(2 ** attempt * 500, 8_000));
      }
    }

    throw lastError || new Base44SourceError('Base44 request failed', { retryable: true, entity });
  }

  async ping() {
    return this.#call({ op: 'ping' });
  }

  // Base44 counts by walking pages, so this is a real round trip, not a cheap
  // metadata read. Callers use it for reconciliation, not per page.
  async count(entity) {
    const res = await this.#call({ op: 'count', entity }, { entity });
    return Number(res?.count ?? 0);
  }

  // [{ id, updated_date }] ordered by created_date. This is what makes
  // reconciliation possible without downloading every record.
  async ids(entity, { skip = 0, limit = MAX_PAGE } = {}) {
    const res = await this.#call({ op: 'ids', entity, skip, limit }, { entity });
    return Array.isArray(res?.rows) ? res.rows : [];
  }

  async read(entity, { skip = 0, limit = MAX_PAGE, fields = null } = {}) {
    const res = await this.#call(
      { op: 'read', entity, skip, limit, ...(fields ? { fields } : {}) },
      { entity },
    );
    return Array.isArray(res?.rows) ? res.rows : [];
  }

  async filter(entity, query, { skip = 0, limit = MAX_PAGE, fields = null, sort = 'updated_date' } = {}) {
    const res = await this.#call(
      { op: 'filter', entity, query, skip, limit, sort, ...(fields ? { fields } : {}) },
      { entity },
    );
    return Array.isArray(res?.rows) ? res.rows : [];
  }

  // Page through everything. `onPage` is called per page so a caller can stream
  // into the database instead of holding an entity in memory.
  //
  // The guard matters: Base44 caps `skip`, and a source that keeps returning
  // full pages forever would loop without it. Hitting the cap is reported as a
  // hard error rather than silently truncating, because a silently truncated
  // pull is exactly what makes a sync delete real records.
  async readAll(entity, { pageSize = MAX_PAGE, maxPages = 400, fields = null, onPage = null } = {}) {
    const all = [];
    let skip = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.read(entity, { skip, limit: pageSize, fields });
      if (onPage) await onPage(rows, { skip, page });
      else all.push(...rows);
      if (rows.length < pageSize) return onPage ? null : all;
      skip += pageSize;
    }
    throw new Base44SourceError(
      `Base44 entity ${entity} exceeded ${maxPages} pages. Refusing to treat a truncated pull as complete.`,
      { retryable: false, entity },
    );
  }


  // Read a deterministic delta ordered by updated_date. The lower bound is
  // inclusive on purpose: a retry re-reads the final timestamp and the sync's
  // fingerprints make that harmless. This prevents records sharing the same
  // timestamp from falling through a cursor boundary.
  async readAllSince(entity, since, { pageSize = MAX_PAGE, maxPages = 400, onPage = null } = {}) {
    const all = [];
    let skip = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.filter(
        entity,
        { updated_date: { $gte: since } },
        { skip, limit: pageSize, sort: 'updated_date' },
      );
      if (onPage) await onPage(rows, { skip, page });
      else all.push(...rows);
      if (rows.length < pageSize) return onPage ? null : all;
      skip += pageSize;
    }
    throw new Base44SourceError(
      `Base44 entity ${entity} delta exceeded ${maxPages} pages. Refusing to advance a truncated cursor.`,
      { retryable: false, entity },
    );
  }
}

export default Base44Source;
