# DashFlo marketing website

`dist/` is the approved prebuilt static production bundle supplied as
`docs/DashFlo-site.zip` (SHA-256
`4455c10578190ceb5f3b02dfb30b47f7291ef1523cc2d9309babdf7cc61c03e0`).

The compiled design is preserved. Production-only additions are limited to:

- canonical and Open Graph metadata;
- theme-aware DashFlo favicon links;
- the supplied light/dark DashFlo icon assets;
- a small CSS override that replaces the bundle's generated brand mark.

Deploy the contents of `dist/` to `/var/www/dashflo` and serve them with
`deploy/nginx/dashflo.io.conf`. No Node or Vite process is required.
