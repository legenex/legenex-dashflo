import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routerPath = path.join(root, 'marketing/dist/assets/site-router.js');
const cssPath = path.join(root, 'marketing/dist/assets/legal.css');
const indexPath = path.join(root, 'marketing/dist/index.html');
const routerSource = fs.readFileSync(routerPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');
const indexSource = fs.readFileSync(indexPath, 'utf8');

const routes = [
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/cookies', 'Cookie Policy'],
  ['/privacy-choices', 'Privacy Choices'],
  ['/health-privacy', 'Consumer Health Data Privacy Policy'],
];

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
  assert(html.includes('Next Consulting LLC dba DashFlo'), `${route}: legal operator missing`);
  assert(html.includes('info@next-consulting.co'), `${route}: contact missing`);
  assert(html.includes('class="legal-toc"'), `${route}: table of contents missing`);
  assert(html.includes('class="legal-site-footer"'), `${route}: footer missing`);
  assert(document.elements.get('link[rel="canonical"]').attributes.href === `https://dashflo.io${route}`, `${route}: canonical mismatch`);
  assert(document.elements.get('meta[property="og:url"]').attributes.content === `https://dashflo.io${route}`, `${route}: Open Graph URL mismatch`);
  assert(document.elements.get('meta[name="robots"]').content === 'index, follow', `${route}: robots metadata mismatch`);

  const internalLinks = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((match) => match[1]);
  for (const href of internalLinks) {
    assert(href === '/' || routes.some(([known]) => known === href), `${route}: unknown internal link ${href}`);
  }
}

assert(indexSource.includes('/assets/site-router.js'), 'index does not load the legal router');
assert(indexSource.includes('/assets/legal.css'), 'index does not load legal styles');
assert(routerSource.includes('patchHomepage()'), 'homepage footer patch is not installed');
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

console.log(`[legal] OK: ${routes.length} routes rendered with metadata, identity, navigation, theme, accessibility, and responsive hooks.`);
