import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routerPath = path.join(root, 'marketing/dist/assets/site-router.js');
const cssPath = path.join(root, 'marketing/dist/assets/legal.css');
const indexPath = path.join(root, 'marketing/dist/index.html');
const brandCssPath = path.join(root, 'marketing/dist/assets/brand.css');
const routerSource = fs.readFileSync(routerPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');
const indexSource = fs.readFileSync(indexPath, 'utf8');
const brandCss = fs.readFileSync(brandCssPath, 'utf8');

const LEGAL_CONTACT = 'info@dashflo.io';
const SUPPORT_CONTACT = 'support@dashflo.io';

const routes = [
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/cookies', 'Cookie Policy'],
  ['/privacy-choices', 'Privacy Choices'],
  ['/health-privacy', 'Consumer Health Data Privacy Policy'],
];

// Rendered routes that are not legal documents. They share the shell and the
// footer, so they are checked for the same structure.
const extraRoutes = [['/contact', 'Contact DashFlo']];

// Every internal destination the rendered pages are allowed to link to.
const knownInternal = new Set(['/', '/contact', ...routes.map(([path]) => path)]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fakeDocument() {
  const elements = new Map();
  const makeMeta = () => ({
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  });
  for (const selector of [
    'meta[name="description"]',
    'link[rel="canonical"]',
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:url"]',
    'meta[name="theme-color"]',
  ]) elements.set(selector, makeMeta());

  const pageRoot = { innerHTML: '' };
  const head = {
    appendChild(element) {
      if (element.name === 'robots') elements.set('meta[name="robots"]', element);
    },
  };
  return {
    title: '',
    body: { className: '' },
    documentElement: { dataset: {} },
    head,
    createElement() { return { content: '', name: '', setAttribute() {} }; },
    getElementById(id) { return id === 'root' ? pageRoot : null; },
    querySelector(selector) { return elements.get(selector) || null; },
    querySelectorAll() { return []; },
    pageRoot,
    elements,
  };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const [route, title] of routes) {
  const document = fakeDocument();
  const location = { pathname: route };
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const run = new AsyncFunction('document', 'location', 'localStorage', 'MutationObserver', routerSource);
  await run(document, location, localStorage, class {});

  const html = document.pageRoot.innerHTML;
  assert(document.title === `${title} | DashFlo`, `${route}: title mismatch`);
  assert(document.body.className === 'legal-body', `${route}: legal body class missing`);
  assert(html.includes(`<h1>${title}</h1>`), `${route}: h1 missing`);
  // The operating company is still identified inside the legal documents,
  // which is where naming the contracting party actually matters.
  assert(html.includes('Next Consulting LLC dba DashFlo'), `${route}: legal operator missing`);
  assert(html.includes(LEGAL_CONTACT), `${route}: legal contact address missing`);
  assert(!html.includes('info@next-consulting.co'), `${route}: retired contact address still present`);
  assert(html.includes('class="legal-toc"'), `${route}: table of contents missing`);
  assert(html.includes('class="legal-site-footer"'), `${route}: footer missing`);
  assert(document.elements.get('link[rel="canonical"]').attributes.href === `https://dashflo.io${route}`, `${route}: canonical mismatch`);
  assert(document.elements.get('meta[property="og:url"]').attributes.content === `https://dashflo.io${route}`, `${route}: Open Graph URL mismatch`);
  assert(document.elements.get('meta[name="robots"]').content === 'index, follow', `${route}: robots metadata mismatch`);

  const internalLinks = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((match) => match[1]);
  for (const href of internalLinks) {
    assert(knownInternal.has(href), `${route}: unknown internal link ${href}`);
  }
}

// The contact route renders through the same shell and must behave like the
// rest of the site.
for (const [route, title] of extraRoutes) {
  const document = fakeDocument();
  const location = { pathname: route, search: '' };
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const run = new AsyncFunction('document', 'location', 'localStorage', 'MutationObserver', routerSource);
  await run(document, location, localStorage, class {});

  const html = document.pageRoot.innerHTML;
  assert(document.title === title, `${route}: title mismatch`);
  assert(html.includes(`<h1>${title}</h1>`), `${route}: h1 missing`);
  assert(html.includes('class="legal-site-footer"'), `${route}: shared footer missing`);
  assert(html.includes('<form class="contact-form"'), `${route}: contact form missing`);
  assert(html.includes('class="contact-trap"'), `${route}: honeypot field missing`);
  // Accessible labelling: every control carries a matching label.
  for (const field of ['name', 'email', 'company', 'topic', 'subject', 'message']) {
    assert(html.includes(`for="${field}"`), `${route}: label for ${field} missing`);
    assert(html.includes(`id="${field}"`), `${route}: control ${field} missing`);
  }
  assert(html.includes('aria-live="polite"'), `${route}: submission status is not announced`);
  assert(html.includes(SUPPORT_CONTACT), `${route}: public support address missing`);
  assert(document.elements.get('link[rel="canonical"]').attributes.href === `https://dashflo.io${route}`, `${route}: canonical mismatch`);

  const internalLinks = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((match) => match[1]);
  for (const href of internalLinks) {
    assert(knownInternal.has(href), `${route}: unknown internal link ${href}`);
  }
}

// Public footer identity. The operating company belongs in the legal documents,
// not on every marketing page, and the public address is the support mailbox.
{
  const footer = routerSource.slice(
    routerSource.indexOf('function footerMarkup()'),
    routerSource.indexOf('function setTheme('),
  );
  assert(footer.length > 0, 'footer markup not found');
  assert(!/Next Consulting/i.test(footer), 'public footer still names the operating company');
  assert(!footer.includes('info@next-consulting.co'), 'public footer still shows the retired address');
  assert(routerSource.includes(`const SUPPORT = '${SUPPORT_CONTACT}'`), 'support address constant is not the public support mailbox');
  assert(routerSource.includes(`const CONTACT = '${LEGAL_CONTACT}'`), 'legal contact constant is not the legal mailbox');
  assert(/\$\{SUPPORT\}/.test(footer), 'public footer does not show the support address');
  assert(footer.includes('Contact / Support'), 'public footer is missing the Contact / Support link');
  assert(footer.includes('href="/contact"'), 'public footer does not link to the contact route');
  for (const legal of ['/privacy', '/terms', '/cookies', '/privacy-choices', '/health-privacy']) {
    assert(footer.includes(`href="${legal}"`), `public footer is missing ${legal}`);
  }
}

// Call to action. Request Access is retired, and the logged-out and logged-in
// destinations are the real application routes.
// Matches a quoted label only, so the data-rights sentence in the privacy
// policy ("request access, correction, deletion") is not mistaken for a button.
assert(!/(['"`])Request Access\1/.test(routerSource), 'Request Access call to action is still present');
assert(routerSource.includes("const APP_ORIGIN = 'https://app.dashflo.io'"), 'application origin missing');
assert(/const APP_LOGIN = `\$\{APP_ORIGIN\}\/login`/.test(routerSource), 'login route missing');
assert(/const APP_REGISTER = `\$\{APP_ORIGIN\}\/register`/.test(routerSource), 'registration route missing');
assert(!routerSource.includes('/signup'), 'obsolete signup route present');
assert(routerSource.includes('Go To Dashboard'), 'authenticated call to action missing');

/* Authenticated navigation call to action.
 *
 * Signed in, the header link becomes Dashboard and must carry the same primary
 * treatment as the hero button rather than the quiet .sign-in text style. These
 * pin the three parts that make that work, because each one fails silently:
 * a missing class swap looks like a link, keeping .sign-in breaks the 1120px
 * responsive rule, and a missing .nav-cta rule leaves a 42px button in a header
 * sized for 36.
 */
assert(/function promoteToPrimaryCta/.test(routerSource), 'navbar Dashboard promotion helper missing');
assert(
  /promoteToPrimaryCta\(link\);/.test(routerSource),
  'authenticated navbar link is not promoted to the primary call to action',
);
assert(
  /classList\.remove\('sign-in'\)/.test(routerSource),
  'promoted navbar link keeps the sign-in class, which breaks the 1120px responsive rule',
);
assert(
  /classList\.add\('button', 'button-primary'\)/.test(routerSource),
  'promoted navbar link does not take the primary button classes',
);
assert(brandCss.includes('.nav-cta'), 'compact navbar call-to-action sizing missing from brand.css');
assert(brandCss.includes(':focus-visible'), 'navbar call to action has no visible focus state');

/* Brand mark assets.
 *
 * brand.css named the 1254px originals, which are not part of dist/, so a clean
 * deploy rendered no mark and a server still holding them from an earlier
 * deploy sent 385KB to draw a 34px logo. Every URL this stylesheet references
 * must exist in dist/brand/.
 */
for (const ref of brandCss.matchAll(/url\("(\/brand\/[^"]+)"\)/g)) {
  const asset = path.join(root, 'marketing/dist', ref[1]);
  assert(fs.existsSync(asset), `brand.css references ${ref[1]}, which is not in marketing/dist`);
}
assert(routerSource.includes('/api/auth/session-status'), 'session status lookup missing');
assert(/credentials: 'include'/.test(routerSource), 'session status request does not send credentials');
// The marketing site must never hold a token itself.
assert(!/localStorage\.(get|set)Item\(\s*['"`](?!dashflo-theme)/.test(routerSource), 'marketing site stores something other than the theme preference');

assert(indexSource.includes('/assets/site-router.js'), 'index does not load the legal router');
assert(indexSource.includes('/assets/legal.css'), 'index does not load legal styles');
assert(/patchHomepage\(await session\)/.test(routerSource), 'homepage patch is not installed');
assert(routerSource.includes('https://app.dashflo.io'), 'application login link missing');
assert(routerSource.includes('https://docs.dashflo.io'), 'documentation link missing');
assert(cssSource.includes(':root') === false, 'legal CSS must reuse existing theme tokens');
for (const token of ['var(--bg)', 'var(--text)', 'var(--text-2)', 'var(--border)', 'var(--surface)', 'var(--coral)']) {
  assert(cssSource.includes(token), `legal CSS does not use ${token}`);
}
assert(cssSource.includes('@media (max-width: 560px)'), 'mobile breakpoint missing');
assert(cssSource.includes(':focus-visible'), 'visible focus styling missing');
assert(cssSource.includes('prefers-reduced-motion'), 'reduced-motion support missing');

const publicText = `${routerSource}\n${indexSource}`;
for (const forbidden of [
  /\[STATE\]/i,
  /\bTODO\b/,
  /HIPAA compliant/i,
  /GDPR compliant/i,
  /SOC 2 certified/i,
  /we never sell/i,
  /we never share/i,
  /mailto:hello@dashflo\.io/i,
]) assert(!forbidden.test(publicText), `forbidden public claim or placeholder: ${forbidden}`);

console.log(`[legal] OK: ${routes.length} legal routes and ${extraRoutes.length} contact route rendered with metadata, identity, navigation, theme, accessibility, and responsive hooks.`);
console.log('[legal] OK: public footer branding, support address, contact link, and call-to-action routing.');
