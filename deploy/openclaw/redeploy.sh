#!/usr/bin/env bash
# ==============================================================================
# ClawFit OpenClaw VPS Update / Redeploy Script
# Run as root/operator: sudo bash deploy/openclaw/redeploy.sh [git-ref]
# ==============================================================================

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: redeploy.sh must be run as root: sudo bash deploy/openclaw/redeploy.sh [ref]" >&2
  exit 1
fi

APP_DIR="/home/clawfit/app"
TARGET_REF="${1:-main}"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Error: Application directory ${APP_DIR} does not exist." >&2
  exit 1
fi

echo "==> [1/5] Updating repository to ref '${TARGET_REF}' as user 'clawfit'..."
sudo -u clawfit -H bash -c "cd '${APP_DIR}' && git fetch origin && git checkout '${TARGET_REF}' && git pull --ff-only origin '${TARGET_REF}'"

CURRENT_SHA="$(sudo -u clawfit -H bash -c "cd '${APP_DIR}' && git rev-parse HEAD")"
echo "Checked out commit: ${CURRENT_SHA}"

echo "==> [2/5] Installing dependencies with frozen lockfile..."
sudo -u clawfit -H bash -c "cd '${APP_DIR}' && pnpm install --frozen-lockfile"

echo "==> [3/5] Building application and packages..."
sudo -u clawfit -H bash -c "cd '${APP_DIR}' && pnpm build"

echo "==> [4/5] Validating OpenClaw Health plugin..."
sudo -u clawfit -H bash -c "cd '${APP_DIR}' && pnpm openclaw:plugin:validate"

echo "==> [5/5] Restarting ClawFit OpenClaw system service..."
systemctl restart clawfit-openclaw
sleep 3
systemctl is-active --quiet clawfit-openclaw
systemctl status clawfit-openclaw --no-pager

echo "=============================================================================="
echo "Redeployment to ${CURRENT_SHA} finished successfully."
echo "Service is active and running under clawfit:clawfit."
echo "WhatsApp session credentials preserved in /home/clawfit/.openclaw/credentials/."
echo "=============================================================================="
