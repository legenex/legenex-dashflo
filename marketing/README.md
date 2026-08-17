# DashFlo marketing website

`dist/` is the approved prebuilt static production bundle supplied as
`docs/DashFlo-site.zip` (SHA-256
`4455c10578190ceb5f3b02dfb30b47f7291ef1523cc2d9309babdf7cc61c03e0`).

The compiled design is preserved. `assets/index-*.css` and `assets/index-*.js`
are the vendored bundle and are never edited. Everything else is layered on top
of them:

- canonical and Open Graph metadata;
- theme-aware DashFlo favicon links and the light/dark icon assets;
- `assets/brand.css`, a small override replacing the bundle's generated mark;
- `assets/hero.css`, responsive geometry for the hero diagram;
- `assets/legal.css`, the legal layout, shared footer, and contact page;
- `assets/site-router.js`, the route renderer.

`assets/site-router.js` loads the approved React bundle on ordinary marketing
routes, renders the public legal documents on legal routes, and renders the
contact page on `/contact`. The nginx SPA fallback therefore returns HTTP 200
for clean URLs without adding route directories or `.html` suffixes. Route
metadata is set before the page is rendered.

## Hero diagram

The desktop composition is canonical: sources left, DashFlo centre, buyers
right, with animated packets on connecting paths. `hero.css` scales that same
composition down instead of reflowing it into a vertical stack.

The connector SVG in the bundle is `viewBox="0 0 1000 420"` with
`preserveAspectRatio="none"` at 100% by 100%, so it stretches to whatever box
the scene occupies and its path anchors land on fixed fractions of the scene.
Node stacks are positioned on those same fractions, which is why every line
stays attached at any width with only one set of geometry to maintain. The
anchor values are recorded in `hero.css`; if the bundle is ever replaced,
re-read the path data before changing that file.

## Authentication-aware call to action

The homepage asks `app.dashflo.io` whether a session exists and shows either
Login and Start Free Trial, or a single Go To Dashboard. The application
session cookie stays host-only, HttpOnly, and unreadable by this site; the
response is one boolean. Any failure renders the logged-out state. See
`server/src/routes/publicSite.js`.

## Caching

`index.html` is `no-cache`. Fingerprinted bundle assets are immutable for a
year. The hand-authored files above keep stable names and therefore must
revalidate: serving them immutable meant a returning visitor kept an old
`site-router.js` and never received a deploy.

Deploy the contents of `dist/` to `/var/www/dashflo` and serve them with
`deploy/nginx/dashflo.io.conf`. No Node or Vite process is required.

The 1254px source icons are kept in `marketing/brand-src/` and are not
deployed. `dist/brand/` carries only the resized variants the site references.
