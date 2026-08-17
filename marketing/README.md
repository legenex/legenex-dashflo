# DashFlo marketing website

`dist/` is the approved prebuilt static production bundle supplied as
`docs/DashFlo-site.zip` (SHA-256
`4455c10578190ceb5f3b02dfb30b47f7291ef1523cc2d9309babdf7cc61c03e0`).

The compiled design is preserved. Production additions are limited to:

- canonical and Open Graph metadata;
- theme-aware DashFlo favicon links;
- the supplied light/dark DashFlo icon assets;
- a small CSS override that replaces the bundle's generated brand mark;
- a route-aware legal renderer for `/privacy`, `/terms`, `/cookies`,
  `/privacy-choices`, and `/health-privacy`;
- a native-styled legal layout and corrected shared footer.

`assets/site-router.js` loads the approved React bundle on ordinary marketing
routes and renders the public legal documents on legal routes. The nginx SPA
fallback therefore returns HTTP 200 for clean legal URLs without adding route
directories or `.html` suffixes. Legal-route metadata is set before the page is
rendered.

Deploy the contents of `dist/` to `/var/www/dashflo` and serve them with
`deploy/nginx/dashflo.io.conf`. No Node or Vite process is required.
