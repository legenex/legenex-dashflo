import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load .env from the server directory regardless of cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),

  // Absolute path to the built frontend (client/dist). Server serves it in production.
  clientDist: process.env.CLIENT_DIST
    ? path.resolve(process.env.CLIENT_DIST)
    : path.resolve(__dirname, '../../client/dist'),

  // Where uploaded files are stored and served from.
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.resolve(__dirname, '../uploads'),

  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL || '',

  db: {
    // Either a single DATABASE_URL or discrete PG* vars.
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'dashos',
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
    cookieName: 'dashos_token',

    // Google sign-in. The Identity Services ID token flow is used, so only the
    // Client ID is required and it is a public value by design: it is sent to
    // the browser so Google's button can be rendered. No Client Secret is
    // needed for login and none should be set for that purpose.
    //
    // GOOGLE_ALLOWED_DOMAINS restricts sign-in to named Workspace domains
    // (comma separated). Empty means no restriction, which is correct when
    // access is controlled by invitation instead.
    //
    // GOOGLE_ALLOW_SIGNUP lets an unknown, uninvited Google account create an
    // ordinary user. Off by default: authentication is not authorization.
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      allowedDomains: String(process.env.GOOGLE_ALLOWED_DOMAINS || '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
      allowSignup: bool(process.env.GOOGLE_ALLOW_SIGNUP, false),
    },
  },

  // LLM provider adapter. LLM_PROVIDER = anthropic | openai
  llm: {
    provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    anthropicFastModel: process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  // The public marketing website. It may read a single authentication boolean
  // so the homepage can render the right call to action.
  //
  // This is deliberately separate from ALLOWED_ORIGINS. That set also decides
  // which origins may perform cookie-authenticated writes, so widening it to
  // include the marketing site would hand a static, publicly editable surface
  // CSRF trust over the application. The session-status route opts this one
  // origin in for one read instead.
  marketingOrigin: process.env.MARKETING_ORIGIN || 'https://dashflo.io',

  // Public contact form. The destination is fixed here so a browser can never
  // choose who a submission is delivered to.
  contact: {
    recipient: process.env.CONTACT_RECIPIENT || 'info@dashflo.io',
  },

  // Email (password reset / OTP / notifications / contact form). Optional.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'DashOS <no-reply@localhost>',
    fromName: process.env.SMTP_FROM_NAME || 'DashFlo Support',
    secure: bool(process.env.SMTP_SECURE, false),
  },

  // Third-party integration secrets (used by ported functions; each fails
  // gracefully with a clear "not configured" message when absent).
  integrations: {
    leadbyteApiKey: process.env.LEADBYTE_API_KEY || '',
    leadbyteBaseUrl: process.env.LEADBYTE_BASE_URL || '',
    hlrApiKey: process.env.HLR_API_KEY || '',
    hlrBaseUrl: process.env.HLR_BASE_URL || '',
    trustedFormApiKey: process.env.TRUSTEDFORM_API_KEY || '',
    metaAccessToken: process.env.META_ACCESS_TOKEN || '',
    mercuryApiKey: process.env.MERCURY_API_KEY || '',
    stripeApiKey: process.env.STRIPE_API_KEY || '',
    xeroClientId: process.env.XERO_CLIENT_ID || '',
    xeroClientSecret: process.env.XERO_CLIENT_SECRET || '',
    googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    googlePrivateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    whatsappToken: process.env.WHATSAPP_TOKEN || '',
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',
  },
};

export default config;
