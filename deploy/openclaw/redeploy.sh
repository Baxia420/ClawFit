#!/usr/bin/env bash
# Upgrade an existing CIA installation; preserves WhatsApp credentials and secrets.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "Run as root: sudo bash deploy/openclaw/redeploy.sh approved-git-ref" >&2; exit 1; }
APP_DIR=/home/clawfit/app
TARGET_REF="${1:?Supply an approved branch, tag or commit SHA}"
[[ -d "$APP_DIR/.git" ]] || { echo "Application checkout is missing." >&2; exit 1; }
[[ "$TARGET_REF" != -* ]] || { echo "Invalid git ref." >&2; exit 1; }

sudo -u clawfit -H bash -c '
  set -euo pipefail
  cd "$1"
  [[ -z "$(git status --porcelain)" ]] || { echo "Checkout contains local changes; upgrade stopped." >&2; exit 1; }
  git fetch origin
  if git show-ref --verify --quiet "refs/remotes/origin/$2"; then
    git checkout --detach "origin/$2"
  else
    git checkout --detach "$2"
  fi
  pnpm install --frozen-lockfile
  pnpm --filter @clawfit/health-core build
  pnpm --filter @clawfit/db build
  pnpm openclaw:plugin:validate
' bash "$APP_DIR" "$TARGET_REF"

systemctl stop clawfit-openclaw
trap 'systemctl stop clawfit-openclaw; echo "Upgrade stopped before verification completed. Gateway is stopped; restore the previous commit/config or resolve the reported check before restarting." >&2' ERR
bash "$APP_DIR/deploy/openclaw/repair-state.sh"
sudo -u clawfit -H bash -c '
  set -euo pipefail
  cd "$1"
  pnpm openclaw:setup
  # No real model calls on upgrade: reuse a fresh, verified report. If absent/stale,
  # stop and run models:smoke explicitly, then retry this approved upgrade.
  pnpm models:configure
  pnpm openclaw:preflight --before-restart
' bash "$APP_DIR"
systemctl start clawfit-openclaw
sudo -u clawfit -H bash -c 'cd "$1" && pnpm openclaw:preflight' bash "$APP_DIR"
trap - ERR
echo "Upgrade checks passed. Live Gemini and WhatsApp read-only acceptance still need verification; see docs/deployment.md."
