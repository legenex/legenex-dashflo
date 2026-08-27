#!/usr/bin/env bash
# Restricted root deployment helper for DashFlo.
#
# Installed at /usr/local/sbin/dashflo-deploy-root on the production VPS and
# invoked over passwordless sudo by the dashflo user, only from
# .github/workflows/deploy-production.yml's "Deploy on the VPS" step. It is
# the one place ordinary deployment touches anything outside the dashflo
# user's own files: publishing the marketing build and reloading nginx.
#
# Usage:
#   dashflo-deploy-root marketing   publish marketing/dist to /var/www/dashflo
#   dashflo-deploy-root nginx       install deploy/nginx/*.conf, validate, reload
#
# Never reissues a certificate and never touches PostgreSQL, Docker, or
# server/.env. nginx is only ever reloaded after nginx -t succeeds.

set -euo pipefail

REPO_DIR="/opt/apps/dashflo"
MARKETING_SRC="$REPO_DIR/marketing/dist"
MARKETING_DEST="/var/www/dashflo"
NGINX_SRC="$REPO_DIR/deploy/nginx"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"

action="${1:-}"

case "$action" in
  marketing)
    if [ ! -d "$MARKETING_SRC" ]; then
      echo "dashflo-deploy-root: $MARKETING_SRC is missing" >&2
      exit 1
    fi
    mkdir -p "$MARKETING_DEST"
    rsync -a --delete "$MARKETING_SRC"/ "$MARKETING_DEST"/
    chown -R www-data:www-data "$MARKETING_DEST"
    echo "dashflo-deploy-root: marketing published to $MARKETING_DEST"
    ;;
  nginx)
    if [ ! -d "$NGINX_SRC" ]; then
      echo "dashflo-deploy-root: $NGINX_SRC is missing" >&2
      exit 1
    fi
    shopt -s nullglob
    confs=("$NGINX_SRC"/*.conf)
    shopt -u nullglob
    if [ "${#confs[@]}" -eq 0 ]; then
      echo "dashflo-deploy-root: no *.conf files in $NGINX_SRC" >&2
      exit 1
    fi
    # A repository config can fail validation for a reason this host cannot
    # yet satisfy, most commonly a certificate that has not been issued. Track
    # which sites-enabled symlinks are new in this run so a failed `nginx -t`
    # can be undone completely, leaving the previous, already-reloaded
    # configuration serving traffic instead of a half-applied one that only
    # breaks on the next reload or reboot.
    created_links=()
    for conf in "${confs[@]}"; do
      name="$(basename "$conf")"
      cp "$conf" "$SITES_AVAILABLE/$name"
      if [ ! -e "$SITES_ENABLED/$name" ]; then
        created_links+=("$SITES_ENABLED/$name")
      fi
      ln -sf "$SITES_AVAILABLE/$name" "$SITES_ENABLED/$name"
    done
    if nginx -t; then
      systemctl reload nginx
      echo "dashflo-deploy-root: nginx configuration installed, validated, and reloaded"
    else
      echo "dashflo-deploy-root: nginx -t failed, rolling back newly enabled sites" >&2
      for link in "${created_links[@]+"${created_links[@]}"}"; do
        rm -f "$link"
      done
      echo "dashflo-deploy-root: rollback complete, previous configuration is unchanged and still active" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: dashflo-deploy-root {marketing|nginx}" >&2
    exit 1
    ;;
esac
