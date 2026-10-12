#!/usr/bin/env bash
# Repair dedicated service ownership and refresh its repository-owned unit.
# No credential reset.
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
# The old redeploy.sh calls this file AFTER checking out the new commit. Install
# the launcher here too, so the first upgrade from the old script takes effect.
# New redeploy.sh also installs the target unit, including on rollback to an old
# commit whose repair script does not know about the launcher.
APP_DIR=/home/clawfit/app
sudo -u clawfit -H node "$APP_DIR/scripts/openclaw-gateway.mjs" --check
install -m 644 "$APP_DIR/deploy/openclaw/clawfit-openclaw.service" /etc/systemd/system/clawfit-openclaw.service
systemctl daemon-reload
echo "Service-user directories and unit updated; credentials and secrets preserved."
