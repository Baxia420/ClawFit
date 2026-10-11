#!/usr/bin/env bash
# Repair only the dedicated service's agent/workspace directories. No credential reset.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "Run as root: sudo bash deploy/openclaw/repair-state.sh" >&2; exit 1; }
id clawfit >/dev/null
STATE_DIR=/home/clawfit/.openclaw
for directory in /home/clawfit "$STATE_DIR" "$STATE_DIR/agents" "$STATE_DIR/agents/main" "$STATE_DIR/agents/main/agent" "$STATE_DIR/agents/main/sessions" "$STATE_DIR/workspace" /home/clawfit/.cache /home/clawfit/.cache/openclaw; do
  [[ ! -L "$directory" ]] || { echo "Refusing a symlinked state directory." >&2; exit 1; }
  install -d -o clawfit -g clawfit -m 700 "$directory"
done
# Prior sudo commands may have created root-owned main-agent files. Limit repair to
# these two trees, do not follow symlinks or touch WhatsApp credentials/settings.
for directory in "$STATE_DIR/agents/main" "$STATE_DIR/workspace"; do
  find "$directory" -xdev -user root \( -type f -o -type d \) -exec chown clawfit:clawfit {} +
done
echo "Service-user state directories repaired; credentials and secrets preserved."
