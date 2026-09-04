#!/usr/bin/env bash
# ==============================================================================
# ClawFit OpenClaw VPS Host Bootstrap Script
# Target OS: Ubuntu 24.04 LTS / Debian 12 (Linux x86_64 or ARM64)
# Run as root: sudo bash deploy/openclaw/bootstrap.sh
# ==============================================================================

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: bootstrap.sh must be run as root: sudo bash deploy/openclaw/bootstrap.sh" >&2
  exit 1
fi

echo "==> [1/9] Setting system timezone to Asia/Kuala_Lumpur..."
timedatectl set-timezone Asia/Kuala_Lumpur || true

echo "==> [2/9] Installing base host prerequisites..."
apt-get update -y
apt-get install -y curl ca-certificates git gnupg ufw build-essential

echo "==> [3/9] Creating dedicated service user: clawfit..."
if ! id -u clawfit >/dev/null 2>&1; then
  useradd -m -s /bin/bash -d /home/clawfit clawfit
  echo "User 'clawfit' created."
else
  echo "User 'clawfit' already exists."
fi

echo "==> [4/9] Setting up secure state directories and private compile cache..."
mkdir -p /home/clawfit/.openclaw/credentials/whatsapp/default
mkdir -p /home/clawfit/.openclaw/agents/main/sessions
mkdir -p /home/clawfit/.openclaw/workspace
mkdir -p /home/clawfit/app
mkdir -p /home/clawfit/.cache/openclaw

chmod 700 /home/clawfit
chmod 700 /home/clawfit/.openclaw
chmod 700 /home/clawfit/.openclaw/credentials
chmod 700 /home/clawfit/.openclaw/credentials/whatsapp
chmod -R 700 /home/clawfit/.cache
chown -R clawfit:clawfit /home/clawfit

echo "==> [5/9] Installing Node.js 24 and pnpm 11.19.0..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# Ensure exact repository-pinned pnpm 11.19.0
corepack enable || npm install -g pnpm@11.19.0
corepack prepare pnpm@11.19.0 --activate || npm install -g pnpm@11.19.0

echo "Node version: $(node -v)"
echo "pnpm version: $(pnpm -v)"

echo "==> [6/9] Installing OpenClaw CLI pinned version 2026.7.1-2..."
npm install -g openclaw@2026.7.1-2
echo "OpenClaw version: $(openclaw --version)"

echo "==> [7/9] Provisioning WhatsApp channel plugin for clawfit..."
# Provision plugin deterministically under clawfit home directory before pairing
sudo -u clawfit -H openclaw plugins install @openclaw/whatsapp@2026.7.1 --pin --acknowledge-clawhub-risk || true
sudo -u clawfit -H openclaw plugins enable whatsapp || true
sudo -u clawfit -H openclaw plugins inspect whatsapp

echo "==> [8/9] Enforcing UFW firewall security baseline..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw --force enable
echo "UFW enabled: only inbound SSH (port 22) is open."

echo "==> [9/9] Installing systemd system service..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/clawfit-openclaw.service" /etc/systemd/system/clawfit-openclaw.service
systemctl daemon-reload
systemctl enable clawfit-openclaw.service

if [[ ! -f /home/clawfit/.openclaw/.env ]]; then
  cp "${SCRIPT_DIR}/openclaw.env.template" /home/clawfit/.openclaw/.env
  chown clawfit:clawfit /home/clawfit/.openclaw/.env
  chmod 600 /home/clawfit/.openclaw/.env
  echo "Initialized /home/clawfit/.openclaw/.env from template."
else
  echo "/home/clawfit/.openclaw/.env already exists."
fi

echo "=============================================================================="
echo "ClawFit OpenClaw VPS host bootstrap completed successfully."
echo "Do NOT start the systemd service until initial deployment configuration is complete."
echo "Follow the complete First Deploy runbook in docs/deployment.md."
echo "=============================================================================="
