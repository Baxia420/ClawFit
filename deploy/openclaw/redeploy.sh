#!/usr/bin/env bash
# ==============================================================================
# ClawFit OpenClaw VPS Update / Redeploy Script
# Run as clawfit user or root: sudo -u clawfit bash redeploy.sh [git-ref]
# ==============================================================================

set -euo pipefail

APP_DIR="/home/clawfit/app"
TARGET_REF="${1:-main}"

echo "==> [1/6] Navigating to application directory: ${APP_DIR}..."
cd "${APP_DIR}"

echo "==> [2/6] Fetching approved git ref: ${TARGET_REF}..."
git fetch origin
git checkout "${TARGET_REF}"
git pull --ff-only origin "${TARGET_REF}" || true
CURRENT_SHA="$(git rev-parse HEAD)"
echo "Checked out commit: ${CURRENT_SHA}"

echo "==> [3/6] Installing dependencies with frozen lockfile..."
pnpm install --frozen-lockfile

echo "==> [4/6] Building application and packages..."
pnpm build

echo "==> [5/6] Validating OpenClaw Health plugin..."
pnpm openclaw:plugin:validate

echo "==> [6/6] Restarting ClawFit OpenClaw service..."
sudo systemctl restart clawfit-openclaw

echo "Waiting for service to stabilize..."
sleep 3
sudo systemctl status clawfit-openclaw --no-pager

echo "Checking WhatsApp channel status..."
openclaw channels status --channel whatsapp --probe || true

echo "=============================================================================="
echo "Redeployment to ${CURRENT_SHA} finished successfully."
echo "WhatsApp session credentials preserved in /home/clawfit/.openclaw/credentials/."
echo "=============================================================================="
