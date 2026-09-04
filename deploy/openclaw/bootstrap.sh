#!/usr/bin/env bash
# ==============================================================================
# ClawFit OpenClaw VPS Host Bootstrap Script
# Target OS: Ubuntu 24.04 LTS / Debian 12 (Linux x86_64 or ARM64)
# Run as root: sudo bash bootstrap.sh
# ==============================================================================

set -euo pipefail

echo "==> [1/8] Setting system timezone to Asia/Kuala_Lumpur..."
timedatectl set-timezone Asia/Kuala_Lumpur || true

echo "==> [2/8] Creating dedicated service user: clawfit..."
if ! id -u clawfit >/dev/null 2>&1; then
  useradd -m -s /bin/bash -d /home/clawfit clawfit
  echo "User 'clawfit' created."
else
  echo "User 'clawfit' already exists."
fi

echo "==> [3/8] Setting up secure state directories..."
mkdir -p /home/clawfit/.openclaw/credentials/whatsapp/default
mkdir -p /home/clawfit/.openclaw/agents/main/sessions
mkdir -p /home/clawfit/.openclaw/workspace
mkdir -p /home/clawfit/app
mkdir -p /var/tmp/openclaw-compile-cache

chmod 700 /home/clawfit/.openclaw
chmod 700 /home/clawfit/.openclaw/credentials
chmod 700 /home/clawfit/.openclaw/credentials/whatsapp
chmod 777 /var/tmp/openclaw-compile-cache
chown -R clawfit:clawfit /home/clawfit

echo "==> [4/8] Installing Node.js 24 and pnpm if missing..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs build-essential
fi

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@11.19.0
fi

echo "==> [5/8] Installing OpenClaw CLI..."
npm install -g openclaw@2026.7.1-2

echo "==> [6/8] Configuring UFW firewall..."
if command -v ufw >/dev/null 2>&1; then
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment 'SSH'
  ufw --force enable
  echo "UFW enabled (inbound SSH only)."
fi

echo "==> [7/8] Installing systemd service..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/clawfit-openclaw.service" /etc/systemd/system/clawfit-openclaw.service
systemctl daemon-reload
systemctl enable clawfit-openclaw.service

echo "==> [8/8] Preparing environment file..."
if [[ ! -f /home/clawfit/.openclaw/.env ]]; then
  cp "${SCRIPT_DIR}/openclaw.env.template" /home/clawfit/.openclaw/.env
  chown clawfit:clawfit /home/clawfit/.openclaw/.env
  chmod 600 /home/clawfit/.openclaw/.env
  echo "Created /home/clawfit/.openclaw/.env from template."
  echo "IMPORTANT: Edit /home/clawfit/.openclaw/.env and set your production secrets."
else
  echo "/home/clawfit/.openclaw/.env already exists."
fi

echo "=============================================================================="
echo "ClawFit OpenClaw VPS bootstrap completed successfully."
echo "Next Steps:"
echo " 1. Clone/deploy ClawFit repository into /home/clawfit/app"
echo " 2. Populate /home/clawfit/.openclaw/.env with real secrets"
echo " 3. Run interactive WhatsApp QR pairing: sudo -u clawfit openclaw channels login --channel whatsapp"
echo " 4. Start the service: sudo systemctl start clawfit-openclaw"
echo "=============================================================================="
