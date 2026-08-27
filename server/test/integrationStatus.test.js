import { describe, it, expect, vi } from 'vitest';
import integrationStatus from '../src/functions/integrationStatus.js';

const USER = { id: 'user-1', email: 'user@example.test', base_role: 'admin', role: 'admin' };

function context({ db, config = {}, env = {} }) {
  return {
    user: USER,
    db,
    config: { integrations: {}, ...config },
    env,
    json: (body, status = 200) => ({ __httpResponse: true, body, status }),
  };
}

function dbWithConfig(name, config) {
  return {
    entities: {
      IntegrationConfig: {
        filter: vi.fn(async (f) => (f.name === name ? [{ config: JSON.stringify(config) }] : [])),
      },
    },
  };
}

describe('integrationStatus', () => {
  it('reports Stripe connected when a secret is stored in IntegrationConfig, not just env', async () => {
    // Settings > Integrations saves through saveIntegrationConfig into the
    // database, never into process.env. The status check used to look only
    // at env (and a config.integrations binding that is itself env-only, see
    // server/src/config.js), so a real, working, DB-stored credential showed
    // as "Not connected".
    const db = dbWithConfig('stripe', { secret_key: 'sk_live_example' });
    const out = await integrationStatus(context({ db }));
    expect(out.status.stripe).toBe(true);
  });

  it('reports Stripe not connected when nothing is stored anywhere', async () => {
    const db = { entities: { IntegrationConfig: { filter: vi.fn().mockResolvedValue([]) } } };
    const out = await integrationStatus(context({ db }));
    expect(out.status.stripe).toBe(false);
  });

  it('still honors the env fallback for providers with no DB-backed config yet', async () => {
    const db = { entities: { IntegrationConfig: { filter: vi.fn().mockResolvedValue([]) } } };
    const out = await integrationStatus(context({ db, env: { MERCURY_API_KEY: 'present' } }));
    expect(out.status.mercury).toBe(true);
  });

  it('checks xero and whatsapp against IntegrationConfig the same way', async () => {
    const xeroDb = dbWithConfig('xero', { client_id: 'abc', client_secret: 'shh' });
    expect((await integrationStatus(context({ db: xeroDb }))).status.xero).toBe(true);

    const whatsappDb = dbWithConfig('whatsapp', { access_token: 'shh' });
    expect((await integrationStatus(context({ db: whatsappDb }))).status.whatsapp).toBe(true);
  });
});
