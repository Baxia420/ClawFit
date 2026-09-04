# ClawFit Production Deployment & 24/7 Hosting Runbook

This document details the production deployment, hosting topology, security baseline, and operational procedures for ClawFit Stage 3.

---

## 1. Production Topology & Architecture

ClawFit operates as a multi-tier, decoupled personal health stack:

```
                  WhatsApp Network
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Always-On Linux VPS (Singapore) │
        │  OpenClaw Gateway 2026.7.1-2     │
        │  - systemd system service        │
        │    /etc/systemd/system/          │
        │    clawfit-openclaw.service      │
        │  - User: clawfit, Group: clawfit │
        │  - Baileys WhatsApp Web session  │
        │  - @clawfit/openclaw-health      │
        └────────────────┬─────────────────┘
                         │ HTTPS
                         │ Bearer: HEALTH_API_OPENCLAW_TOKEN
                         │ Headers: x-clawfit-sender-id, x-clawfit-conversation-id
                         ▼
        ┌──────────────────────────────────┐
        │  Render Web Service (Singapore)  │
        │  ClawFit Health API (Node 24)    │
        │  - Fastify, strict Zod schemas   │
        │  - Dual machine token validation │
        │  - Logger identity redaction     │
        └───────────┬──────────────┬───────┘
                    │              │
      DATABASE_URL  │              │ Google GenAI SDK
      (pooled SSL)  │              │ (NUTRITION_MODEL_PRIMARY)
                    ▼              ▼
        ┌──────────────────┐  ┌─────────────┐
        │ Neon PostgreSQL  │  │   Gemini    │
        │ (ap-southeast-1) │  │  Flash/Pro  │
        └──────────────────┘  └─────────────┘
                    ▲
      DATABASE_URL  │ (Read/Write via API)
                    │
        ┌───────────┴──────────────────────┐
        │  Vercel Web App (Private Access) │
        │  Next.js 16 (PWA)                │
        │  Bearer: HEALTH_API_WEB_TOKEN    │
        └──────────────────────────────────┘
```

---

## 2. Region Strategy

The primary users reside in Malaysia (Kuala Lumpur). All backend components are aligned to **Singapore** (`ap-southeast-1` / `singapore`) to achieve sub-20ms round-trip latency:
- **OpenClaw VPS**: Singapore region (DigitalOcean, Hetzner, AWS, Linode, or equivalent).
- **Render Health API**: `singapore` region (configured in `render.yaml`).
- **Neon PostgreSQL**: Singapore (`ap-southeast-1`) region.
- **Application Timezone**: `Asia/Kuala_Lumpur` (UTC+8) configured explicitly across all nodes.

---

## 3. OpenClaw Persistence Audit Findings

Audit of the installed OpenClaw runtime (`openclaw@2026.7.1-2` and `@openclaw/whatsapp`) verified the exact file and directory paths that maintain persistent state:

| Path | Purpose | Persistence Requirement |
|---|---|---|
| `/home/clawfit/.openclaw/credentials/whatsapp/default/creds.json` | Baileys cryptographic session keys | **Critical**. Must survive process restarts, system reboots, and redeployments. Re-pairing QR is never needed if preserved. |
| `/home/clawfit/.openclaw/credentials/whatsapp/default/creds.json.bak` | Automatic backup of session credentials | **Critical**. Secondary session key backup. |
| `/home/clawfit/.openclaw/credentials/whatsapp-allowFrom.json` | WhatsApp allow-store (pairing cache) | **Important**. Preserves dynamic sender pairing records. |
| `/home/clawfit/.openclaw/openclaw.json` | Active Gateway configuration | **Critical**. Defines channel policies, group allowlists, tools, and plugins. |
| `/home/clawfit/.openclaw/.env` | Gateway environment secrets (mode 0600) | **Critical**. Contains API tokens and Gemini keys. |
| `/home/clawfit/.openclaw/agents/main/sessions/` | Chat session jsonl & metadata | **Important**. Preserves recent context and conversation history. |
| `/home/clawfit/app/` | ClawFit repository & built plugin | Application root. Safe to update/pull via Git without affecting credentials. |

> [!CAUTION]
> WhatsApp session credentials must **never** be placed on an ephemeral container filesystem or in a directory wiped by deployment scripts.

---

## 4. Linux VPS Hosting Model Decision

### Evaluation: Native systemd vs Containerized OpenClaw

| Dimension | Option A: Native systemd (Chosen) | Option B: Docker Container |
|---|---|---|
| **Simplicity** | Directly runs `openclaw gateway run`. Zero container abstractions. | Requires `docker run` / compose with complex volume mappings. |
| **Session Persistence** | Direct filesystem persistence in `/home/clawfit/.openclaw/`. No permission friction. | Prone to UID/GID mismatches between host and container user, breaking SQLite / Baileys locks. |
| **Interactive QR Pairing** | Run `openclaw channels login --channel whatsapp` directly in SSH terminal. | Requires attaching to container stdin/stdout or inspecting container logs for ASCII QR. |
| **Process Supervision** | Native `systemd` system service handles restart on failure, backoff throttling, boot auto-start, and `journald`. | Requires Docker daemon auto-start plus container restart policy. |
| **Resource Efficiency** | Minimal RAM footprint (~150 MB). Ideal for 1 GB RAM VPS. | Extra overhead for Docker daemon, containerd, and overlayfs. |

**Decision**: **Native systemd system service (`/etc/systemd/system/clawfit-openclaw.service`) under dedicated service account `clawfit`** is chosen for superior reliability, direct terminal QR pairing, and fail-safe persistence.

---

## 5. Authoritative First-Deployment Sequence

Follow this exact numbered 15-step sequence on a fresh Linux VPS. Do not start the systemd service before mandatory production configuration is complete.

1. **Bootstrap host prerequisites & system service**:
   ```bash
   # Run as root:
   sudo bash deploy/openclaw/bootstrap.sh
   ```
   This installs `curl`, `ca-certificates`, `git`, `gnupg`, `ufw`, `build-essential`, Node 24, pnpm 11.19.0, OpenClaw 2026.7.1-2, provisions the WhatsApp plugin, configures UFW firewall, creates user `clawfit`, sets up private cache `/home/clawfit/.cache/openclaw`, and installs `/etc/systemd/system/clawfit-openclaw.service`.

2. **Clone approved repository commit**:
   ```bash
   sudo -u clawfit -H git clone https://github.com/Baxia420/ClawFit.git /home/clawfit/app
   cd /home/clawfit/app
   sudo -u clawfit -H git checkout <approved-commit-sha>
   ```

3. **Create protected OpenClaw environment**:
   Edit `/home/clawfit/.openclaw/.env` (mode 0600, owned by `clawfit:clawfit`):
   ```bash
   sudo -u clawfit -H nano /home/clawfit/.openclaw/.env
   ```
   Populate all production secrets:
   - `HEALTH_API_URL=https://<your-service>.onrender.com`
   - `HEALTH_API_OPENCLAW_TOKEN=<min-24-character-token>`
   - `CLAWFIT_WHATSAPP_ALLOW_FROM=+60123456789,+60198765432`
   - `GEMINI_API_KEY=<your-gemini-api-key>`
   - `APP_TIMEZONE=Asia/Kuala_Lumpur`

4. **Install & enable WhatsApp channel plugin**:
   ```bash
   sudo -u clawfit -H openclaw plugins install @openclaw/whatsapp@2026.7.1 --pin --acknowledge-clawhub-risk
   sudo -u clawfit -H openclaw plugins enable whatsapp
   sudo -u clawfit -H openclaw plugins inspect whatsapp
   ```

5. **Build ClawFit workspace**:
   ```bash
   sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm install --frozen-lockfile && pnpm build"
   ```

6. **Configure ClawFit OpenClaw plugin and tool policy**:
   ```bash
   sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm openclaw:setup"
   ```
   This synchronizes variables from `/home/clawfit/.openclaw/.env`, registers `@clawfit/openclaw-health`, sets `tools.profile = "minimal"`, restricts allowed tools to health tools, and enables WhatsApp channel policies.

7. **Configure gateway.mode=local and loopback binding**:
   ```bash
   sudo -u clawfit -H openclaw config set gateway.mode local
   sudo -u clawfit -H openclaw config set gateway.bind loopback
   ```
   (Also performed automatically by `pnpm openclaw:setup`).

8. **Verify Google model availability via live catalog smoke check**:
   ```bash
   sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm models:smoke"
   ```
   This queries Google AI Studio, probes tool-calling capabilities, and writes verified models to `.model-smoke.json`.

9. **Configure ONLY smoke-verified models into OpenClaw**:
   ```bash
   sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm models:configure"
   ```
   Ensures no hardcoded or unverified model IDs are added to `agents.defaults.models` or fallbacks.

10. **Interactive WhatsApp QR pairing**:
    ```bash
    sudo -u clawfit -H openclaw channels login --channel whatsapp
    ```
    Scan the ANSI QR code from the primary WhatsApp mobile app (**Settings** -> **Linked Devices** -> **Link a Device**). Confirm credentials saved to `/home/clawfit/.openclaw/credentials/whatsapp/default/creds.json`.

11. **Discover approved shared WhatsApp group JID**:
    ```bash
    sudo -u clawfit -H openclaw directory groups list --channel whatsapp
    ```
    Locate the shared group and copy its JID (e.g. `120363xxxxxxxxxxxx@g.us`). If not yet returned by directory, check logs as fallback:
    `sudo journalctl -u clawfit-openclaw -n 50 | grep "@g.us"`.

12. **Add group JID to configuration**:
    Add `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS=<group-jid>@g.us` to:
    - `/home/clawfit/.openclaw/.env` on VPS
    - Environment variables on Render Health API dashboard

13. **Rerun OpenClaw configuration**:
    ```bash
    sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm openclaw:setup"
    ```
    Enables `channels.whatsapp.groupPolicy = "allowlist"` and registers the group with `requireMention: false`.

14. **Start the systemd system service**:
    ```bash
    sudo systemctl start clawfit-openclaw
    sudo systemctl status clawfit-openclaw
    ```

15. **Probe WhatsApp & verify readiness**:
    ```bash
    sudo -u clawfit -H openclaw channels status --channel whatsapp --probe
    # Run nutrition readiness smoke check against Render API:
    sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm nutrition:smoke"
    ```
    Send a test direct message from Primary and Partner WhatsApp numbers to verify the assistant responds.

---

## 6. VPS Service Account & Security Baseline

### 6.1 Service User & Filesystem Structure
The service runs under a dedicated, non-root system account:
- User: `clawfit`
- Group: `clawfit`
- Home: `/home/clawfit`
- Application Directory: `/home/clawfit/app`
- Compile Cache: `/home/clawfit/.cache/openclaw` (mode 0700, private)
- OpenClaw Directory: `/home/clawfit/.openclaw` (mode 0700)
- Secret File: `/home/clawfit/.openclaw/.env` (mode 0600)

### 6.2 Network Ingress & Egress Rules
- **Inbound Ports**: Only port `22` (SSH) is permitted. No inbound HTTP, WebSocket, or control ports are exposed to the public internet.
- **Outbound Ports**: Standard HTTPS (`443`) to Render (`*.onrender.com`), Google Gemini API (`generativelanguage.googleapis.com`), and WhatsApp Web WebSocket endpoints.
- **Firewall Setup (UFW)**:
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp comment 'SSH'
  sudo ufw --force enable
  ```

### 6.3 SSH & System Hardening
1. **Disable Password Authentication**: Use Ed25519 SSH keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
2. **Automatic Security Updates**:
   ```bash
   sudo apt-get install -y unattended-upgrades
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
3. **Time Synchronization**:
   ```bash
   sudo timedatectl set-timezone Asia/Kuala_Lumpur
   sudo systemctl enable systemd-timesyncd --now
   ```

---

## 7. Production Secrets Model

Credentials are partitioned strictly by client role:

| Secret | Health API / Render | OpenClaw VPS | Web / Vercel | Browser Client |
|---|---|---|---|---|
| `HEALTH_API_WEB_TOKEN` | Yes (Authoritative) | **NEVER** | Yes (Server-only) | **NEVER** |
| `HEALTH_API_OPENCLAW_TOKEN` | Yes (Authoritative) | Yes (`chmod 600`) | **NEVER** | **NEVER** |
| `DATABASE_URL` (pooled) | Yes (Neon) | **NEVER** | **NEVER** | **NEVER** |
| `DATABASE_DIRECT_URL` (unpooled) | Operator / CI only | **NEVER** | **NEVER** | **NEVER** |
| `GEMINI_API_KEY` | Yes | Yes (for OpenClaw agent turns) | **NEVER** | **NEVER** |
| `NUTRITION_MODEL_PRIMARY` | Yes | Optional | **NEVER** | **NEVER** |
| `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` | Yes | Yes | **NEVER** | **NEVER** |

- The Health API strictly requires `HEALTH_API_WEB_TOKEN !== HEALTH_API_OPENCLAW_TOKEN` and minimum length of 24 characters.
- Fastify logger explicitly redacts all tokens, sender IDs, conversation IDs, and auth headers.

---

## 8. Neon PostgreSQL Deployment & Migration Runbook

### 8.1 Connection String Setup
In the Neon Console (Singapore `ap-southeast-1`):
1. **Pooled Connection String**: Copy the pooled endpoint (contains `-pooler` in host). This is used by Render as `DATABASE_URL`.
2. **Direct Connection String**: Copy the unpooled endpoint. This is used exclusively for running database migrations.

### 8.2 Safe One-Shot Migration Procedure
Never use `drizzle-kit push` or automatic migration on application startup in production.

1. **Pre-Migration Snapshot**: In Neon Console, create a branch snapshot or point-in-time recovery marker before migrating.
2. **Execute Migration**:
   ```powershell
   # On local workstation or deployment runner:
   $env:DATABASE_URL = "<direct-neon-connection-string>"
   pnpm db:migrate
   Remove-Item Env:DATABASE_URL
   ```
3. **Verify Schema Readiness**:
   The migration applies `0004_two_user_identity.sql`. Once applied, verify that the database passes the schema-aware check:
   ```powershell
   # Test API readiness against Neon
   Invoke-RestMethod "https://<render-service>.onrender.com/ready"
   # Returns: { "status": "ready", "database": "ok", "schema": "ok", "estimator": "configured" }
   ```

---

## 9. Render Health API Deployment

### 9.1 Render Blueprint Configuration (`render.yaml`)
Create the service via Render Blueprint or Manual Web Service:
- **Name**: `claw-fit-api`
- **Region**: `singapore`
- **Runtime**: `node`
- **Build Command**: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @clawfit/api build`
- **Start Command**: `pnpm --filter @clawfit/api start`
- **Health Check Path**: `/ready`

### 9.2 Environment Variables on Render
Configure these in the Render dashboard:
- `NODE_ENV`: `production`
- `NODE_VERSION`: `24.15.0`
- `HOST`: `0.0.0.0`
- `APP_TIMEZONE`: `Asia/Kuala_Lumpur`
- `DATABASE_URL`: `<pooled-neon-ssl-url>`
- `HEALTH_API_WEB_TOKEN`: `<distinct-random-token-min-24-chars>`
- `HEALTH_API_OPENCLAW_TOKEN`: `<distinct-random-token-min-24-chars>`
- `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS`: `<approved-group-jid>@g.us`
- `GEMINI_API_KEY`: `<google-ai-studio-key>`
- `NUTRITION_MODEL_PRIMARY`: `<verified-primary-model-from-.model-smoke.json>`
- `NUTRITION_MODEL_FALLBACK`: *(Only configure if verified in `.model-smoke.json`)*

### 9.3 Nutrition Estimator Verification Probe
Before testing WhatsApp meal logging, execute the smoke check:
```bash
pnpm nutrition:smoke
```
This queries `/ready` to confirm `estimator === "configured"` and calls `/v1/nutrition/estimate` to ensure Gemini estimates are functioning end-to-end.

---

## 10. WhatsApp Identity Bootstrap on Production DB

After applying database migrations, link the real WhatsApp accounts to the internal ClawFit user profiles using the administrative script without committing phone numbers to git:

```bash
# On workstation with production database access:
DATABASE_URL="<direct-or-pooled-neon-url>" \
CLAWFIT_PRIMARY_WHATSAPP="+60123456789" \
CLAWFIT_PRIMARY_WHATSAPP_LID="12345678901234@lid" \
CLAWFIT_PARTNER_WHATSAPP="+60198765432" \
CLAWFIT_PARTNER_WHATSAPP_LID="98765432109876@lid" \
pnpm identity:link --from-env
```

The script verifies:
- Primary and Partner profiles exist.
- Phone numbers and LIDs are normalized to E.164 and lowercase LID.
- Console output is masked (`+60****6789 -> user 'primary'`).
- No secrets or real identities are written to disk.

---

## 11. Approved Shared WhatsApp Group Discovery & Setup

### 11.1 Discovering the Group JID
1. Have Primary user create the shared WhatsApp group with Partner and the bot account.
2. In OpenClaw on the VPS, query group directory:
   ```bash
   sudo -u clawfit -H openclaw directory groups list --channel whatsapp
   ```
3. Copy the verified JID (e.g. `120363xxxxxxxxxxxx@g.us`).
4. (Fallback only): If directory is unavailable, check logs:
   ```bash
   sudo journalctl -u clawfit-openclaw -n 50 | grep "@g.us"
   ```

### 11.2 Enforcing 3-Layer Allowlisting
1. **OpenClaw Channel Allowlist**: Set `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` in `/home/clawfit/.openclaw/.env` and run `pnpm openclaw:setup`.
2. **OpenClaw Health Plugin Gate**: `@clawfit/openclaw-health` validates `toolContext.deliveryContext.to` against the allowed group array.
3. **Health API Gate**: Render receives `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` and validates `x-clawfit-conversation-id`.

---

## 12. One-Time WhatsApp QR Pairing & Persistence Procedure

### 12.1 Pairing Runbook
Do not attempt pairing while the systemd service is active.

1. Stop the background service:
   ```bash
   sudo systemctl stop clawfit-openclaw
   ```
2. Start the interactive QR login as user `clawfit`:
   ```bash
   sudo -u clawfit -H openclaw channels login --channel whatsapp
   ```
3. A high-contrast QR code is displayed in the terminal.
4. On the dedicated WhatsApp phone:
   - Open WhatsApp -> **Settings** -> **Linked Devices** -> **Link a Device**.
   - Scan the terminal QR code.
5. Wait for the terminal to confirm: `WhatsApp linked successfully`.
6. Verify credentials were saved to disk:
   ```bash
   ls -la /home/clawfit/.openclaw/credentials/whatsapp/default/creds.json
   ```
7. Start and verify the background service:
   ```bash
   sudo systemctl start clawfit-openclaw
   sudo systemctl status clawfit-openclaw
   sudo -u clawfit -H openclaw channels status --channel whatsapp --probe
   ```

### 12.2 Persistence Guarantee
Once `creds.json` is generated:
- Stopping / restarting `clawfit-openclaw` service **does not require scanning QR again**.
- Rebooting the VPS (`sudo reboot`) **does not require scanning QR again**.
- The service automatically reconnects upon network recovery.

---

## 13. Encrypted Backup & Restore Strategy

Treat `/home/clawfit/.openclaw/` state as sensitive material. Never commit credentials to git.

### 13.1 Backup Contents & Decision
- **Included in Backup**:
  - `credentials/`: Cryptographic Baileys session keys, pre-keys, allow-store.
  - `openclaw.json`: Channel routing and gateway configuration.
- **Excluded / Managed Separately**:
  - `.env`: Secret environment variables (`HEALTH_API_OPENCLAW_TOKEN`, `GEMINI_API_KEY`) are kept in the operator's secure secret manager (1Password, Bitwarden, etc.) and recreated explicitly on a new host.
  - `sessions/`: Transient conversation history cache. Excluded by default to keep backups minimal and privacy-preserving.

### 13.2 Creating an Encrypted Backup
```bash
# On VPS as root or operator:
sudo tar -czf - -C /home/clawfit/.openclaw credentials openclaw.json | \
  gpg --symmetric --cipher-algo AES256 -o /home/clawfit/openclaw-backup-$(date +%F).tar.gz.gpg

# Transfer the .gpg file to an encrypted offline storage location
```

### 13.3 Restoring from Backup
```bash
# On clean VPS after running bootstrap.sh and provisioning /home/clawfit/.openclaw/.env:
sudo systemctl stop clawfit-openclaw
gpg --decrypt /path/to/openclaw-backup.tar.gz.gpg | \
  sudo tar -xzf - -C /home/clawfit/.openclaw/

sudo chown -R clawfit:clawfit /home/clawfit/.openclaw
sudo chmod 700 /home/clawfit/.openclaw
sudo chmod -R 700 /home/clawfit/.openclaw/credentials
sudo chmod 600 /home/clawfit/.openclaw/openclaw.json
sudo systemctl start clawfit-openclaw
```

---

## 14. Health & Service Monitoring

Use these standard commands for operator diagnostics:

```bash
# 1. Systemd Service Status
sudo systemctl status clawfit-openclaw

# 2. Live Process Logs (filtered and auto-redacted)
sudo journalctl -u clawfit-openclaw -f -n 100

# 3. OpenClaw Channel Probe
sudo -u clawfit -H openclaw channels status --channel whatsapp --probe --json

# 4. Health API / Readiness Probe
curl -s "https://<render-service>.onrender.com/health"
curl -s "https://<render-service>.onrender.com/ready"

# 5. Nutrition Estimator Smoke Check
sudo -u clawfit -H bash -c "cd /home/clawfit/app && pnpm nutrition:smoke"

# 6. Fastify Logger Redaction Verification
# Ensure journal logs NEVER show:
# - Full WhatsApp phone numbers or JIDs
# - Bearer tokens or API keys
# - Full meal photo base64 strings
```

---

## 15. Safe Operator Update & Redeploy Procedure

To deploy approved git commits to the VPS without risking WhatsApp credentials or corrupting file ownership:

```bash
# Run as root/operator from repository root:
sudo bash deploy/openclaw/redeploy.sh main
```

The script executes:
1. `git fetch origin && git checkout main && git pull --ff-only` (as user `clawfit`)
2. `pnpm install --frozen-lockfile` (as user `clawfit`)
3. `pnpm build` (as user `clawfit`)
4. `pnpm openclaw:plugin:validate` (as user `clawfit`)
5. `systemctl restart clawfit-openclaw` (as root)
6. `systemctl status clawfit-openclaw` (as root)

All build outputs and repository files remain strictly owned by `clawfit:clawfit`.

### Rollback Procedure
If an issue arises, roll back immediately to the previous approved commit:
```bash
sudo bash deploy/openclaw/redeploy.sh 6f028d5
```

---

## 16. Obsolete Vercel API Integration Removal

The repository previously tested deploying the Fastify API to Vercel (prior to commit `e7b7b60`), which caused routing ambiguity:
1. In the Vercel Dashboard, inspect all projects.
2. If an obsolete project named `claw-fit-api` or pointing to `apps/api` exists, open **Project Settings -> Advanced -> Delete Project**.
3. Confirm that only `claw-fit-web` (pointing to `apps/web`) remains on Vercel.
4. Verify repository root contains no `vercel.json` routing rules for the API.

---

## 17. Manual WhatsApp Acceptance Test Checklist (Post-Stage 3)

Execute after live deployment with real WhatsApp accounts. Do not mark tests passed until verified against the live environment.

| Test ID | Scenario | Status | Expected Outcome |
|---|---|---|---|
| **MAT-01** | Public API readiness probe | `[PENDING]` | `/ready` returns 200 with `{ "status": "ready", "database": "ok", "schema": "ok", "estimator": "configured" }`. |
| **MAT-02** | WhatsApp channel login | `[PENDING]` | `openclaw channels login --channel whatsapp` displays ANSI QR; scans cleanly and creates `creds.json`. |
| **MAT-03** | Systemd service supervision | `[PENDING]` | System service restarts on failure; configuration error 78 stops cleanly without loop; surviving full reboot. |
| **MAT-04** | Primary DM meal logging | `[PENDING]` | Primary user DM query creates pending draft and logs confirmed meal strictly under Primary user ID. |
| **MAT-05** | Partner DM meal logging | `[PENDING]` | Partner user DM query creates pending draft and logs confirmed meal strictly under Partner user ID. |
| **MAT-06** | Primary shared group meal | `[PENDING]` | Primary user meal in shared group logs meal under Primary user ID without polluting Partner totals. |
| **MAT-07** | Partner shared group meal | `[PENDING]` | Partner user meal in shared group logs meal under Partner user ID without polluting Primary totals. |
| **MAT-08** | Unauthorized group participant | `[PENDING]` | Message from non-allowlisted participant in shared group is rejected with 403 `UNAUTHORIZED_SENDER`. |
| **MAT-09** | Unauthorized direct message | `[PENDING]` | Direct message from non-allowlisted phone number is dropped silently by WhatsApp allowlist policy. |
| **MAT-10** | Machine token boundary (Web) | `[PENDING]` | `HEALTH_API_WEB_TOKEN` cannot access OpenClaw sender-routed operations or spoof sender IDs. |
| **MAT-11** | Machine token boundary (OpenClaw) | `[PENDING]` | `HEALTH_API_OPENCLAW_TOKEN` cannot access web internal endpoints without valid sender/conversation context. |
| **MAT-12** | VPS network isolation | `[PENDING]` | Port scan confirms only port 22/tcp is open inbound; OpenClaw has zero public inbound ports. |
| **MAT-13** | Credential & config restoration | `[PENDING]` | Encrypted backup (`credentials/` + `openclaw.json`) restores onto clean host with `.env`, reconnecting to WhatsApp without QR. |
| **MAT-14** | 24/7 autonomous uptime | `[PENDING]` | WhatsApp bot logs meals and replies while developer local PC is completely powered off. |
