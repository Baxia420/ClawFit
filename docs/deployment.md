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
        │  - systemd user service: clawfit │
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
      (pooled SSL)  │              │ (when estimation needed)
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
| **Interactive QR Pairing** | Run `openclaw channels login --channel whatsapp` directly in SSH / tmux. | Requires attaching to container stdin/stdout or inspecting container logs for ASCII QR. |
| **Process Supervision** | Native `systemd` handles restart on failure, backoff throttling, boot auto-start, and `journald`. | Requires Docker daemon auto-start plus container restart policy. |
| **Resource Efficiency** | Minimal RAM footprint (~150 MB). Ideal for 1 GB RAM VPS. | Extra overhead for Docker daemon, containerd, and overlayfs. |

**Decision**: **Native systemd under dedicated service account `clawfit`** is chosen for superior reliability, direct terminal QR pairing, and fail-safe persistence.

---

## 5. VPS Service Account & Security Baseline

### 5.1 Service User & Filesystem Structure
The service runs under a dedicated, non-root system account:
- User: `clawfit`
- Group: `clawfit`
- Home: `/home/clawfit`
- Directory permissions: `chmod 700 /home/clawfit/.openclaw`
- Secret permissions: `chmod 600 /home/clawfit/.openclaw/.env`

### 5.2 Network Ingress & Egress Rules
- **Inbound Ports**: Only port `22` (SSH) is permitted. No inbound HTTP, WebSocket, or control ports are exposed to the public internet.
- **Outbound Ports**: Standard HTTPS (`443`) to Render (`*.onrender.com`), Google Gemini API (`generativelanguage.googleapis.com`), and WhatsApp Web WebSocket endpoints.
- **Firewall Setup (UFW)**:
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp comment 'SSH'
  sudo ufw enable
  ```

### 5.3 SSH & System Hardening
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

## 6. Production Secrets Model

Credentials are partitioned strictly by client role:

| Secret | Health API / Render | OpenClaw VPS | Web / Vercel | Browser Client |
|---|---|---|---|---|
| `HEALTH_API_WEB_TOKEN` | Yes (Authoritative) | **NEVER** | Yes (Server-only) | **NEVER** |
| `HEALTH_API_OPENCLAW_TOKEN` | Yes (Authoritative) | Yes (`chmod 600`) | **NEVER** | **NEVER** |
| `DATABASE_URL` (pooled) | Yes (Neon) | **NEVER** | **NEVER** | **NEVER** |
| `DATABASE_DIRECT_URL` (unpooled) | Operator / CI only | **NEVER** | **NEVER** | **NEVER** |
| `GEMINI_API_KEY` | Yes | Optional / If direct | **NEVER** | **NEVER** |
| `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` | Yes | Yes | **NEVER** | **NEVER** |

- The Health API strictly requires `HEALTH_API_WEB_TOKEN !== HEALTH_API_OPENCLAW_TOKEN` and minimum length of 24 characters.
- Fastify logger explicitly redacts all tokens, sender IDs, conversation IDs, and auth headers.

---

## 7. Neon PostgreSQL Deployment & Migration Runbook

### 7.1 Connection String Setup
In the Neon Console (Singapore `ap-southeast-1`):
1. **Pooled Connection String**: Copy the pooled endpoint (contains `-pooler` in host). This is used by Render as `DATABASE_URL`.
2. **Direct Connection String**: Copy the unpooled endpoint. This is used exclusively for running database migrations.

### 7.2 Safe One-Shot Migration Procedure
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
   # Must return: { "status": "ready" }
   ```

---

## 8. Render Health API Deployment

### 8.1 Render Blueprint Configuration (`render.yaml`)
Create the service via Render Blueprint or Manual Web Service:
- **Name**: `claw-fit-api`
- **Region**: `singapore`
- **Runtime**: `node`
- **Build Command**: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @clawfit/api build`
- **Start Command**: `pnpm --filter @clawfit/api start`
- **Health Check Path**: `/ready`

### 8.2 Environment Variables on Render
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
- `NUTRITION_MODEL_PRIMARY`: `<verified-model-id>`
- `NUTRITION_MODEL_FALLBACK`: `<verified-fallback-id>`

---

## 9. WhatsApp Identity Bootstrap on Production DB

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

## 10. Approved Shared WhatsApp Group Discovery & Setup

### 10.1 Discovering the Group JID
1. Have Primary user create the shared WhatsApp group with Partner and the bot account.
2. In OpenClaw on the VPS, inspect group discovery via:
   ```bash
   sudo -u clawfit openclaw channels resolve --channel whatsapp "Group Name"
   # Or inspect inbound logs:
   sudo -u clawfit openclaw channels logs --channel whatsapp | grep "@g.us"
   ```
3. Copy the verified JID (e.g. `123456789-987654@g.us`).

### 10.2 Enforcing 3-Layer Allowlisting
1. **OpenClaw Channel Allowlist**: Set `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` in `/home/clawfit/.openclaw/.env` and run `pnpm openclaw:setup`.
2. **OpenClaw Health Plugin Gate**: `@clawfit/openclaw-health` validates `toolContext.deliveryContext.to` against the allowed group array.
3. **Health API Gate**: Render receives `CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS` and validates `x-clawfit-conversation-id`.

---

## 11. One-Time WhatsApp QR Pairing & Persistence Procedure

### 11.1 Pairing Runbook
Do not attempt pairing while the systemd service is active.

1. SSH into the VPS and switch to user `clawfit`:
   ```bash
   sudo -u clawfit -i
   cd /home/clawfit/app
   ```
2. Start the interactive QR login inside a tmux or standard terminal session:
   ```bash
   openclaw channels login --channel whatsapp
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
   openclaw channels status --channel whatsapp --probe
   ```

### 11.2 Persistence Guarantee
Once `creds.json` is generated:
- Stopping / restarting `clawfit-openclaw` service **does not require scanning QR again**.
- Rebooting the VPS (`sudo reboot`) **does not require scanning QR again**.
- The service automatically reconnects upon network recovery.

---

## 12. Encrypted Backup & Restore Strategy

Treat `/home/clawfit/.openclaw/credentials/` as sensitive cryptographic material. Never push credentials to git.

### 12.1 Creating an Encrypted Backup
```bash
# On VPS, create GPG-encrypted tarball of OpenClaw state:
sudo tar -czf - -C /home/clawfit/.openclaw credentials | \
  gpg --symmetric --cipher-algo AES256 -o /home/clawfit/openclaw-backup-$(date +%F).tar.gz.gpg

# Transfer the .gpg file to an encrypted offline storage location
```

### 12.2 Restoring from Backup
```bash
# On new VPS after running bootstrap.sh:
gpg --decrypt /path/to/openclaw-backup.tar.gz.gpg | \
  sudo tar -xzf - -C /home/clawfit/.openclaw/

sudo chown -R clawfit:clawfit /home/clawfit/.openclaw/credentials
sudo chmod -R 700 /home/clawfit/.openclaw/credentials
sudo systemctl restart clawfit-openclaw
```

---

## 13. Health & Service Monitoring

Use these standard commands for operator diagnostics:

```bash
# 1. Systemd Service Status
sudo systemctl status clawfit-openclaw

# 2. Live Process Logs (filtered and auto-redacted)
sudo journalctl -u clawfit-openclaw -f -n 100

# 3. OpenClaw Channel Probe
openclaw channels status --channel whatsapp --probe --json

# 4. Health API / Readiness Probe
curl -s "https://<render-service>.onrender.com/health"
curl -s "https://<render-service>.onrender.com/ready"

# 5. Fastify Logger Redaction Verification
# Ensure journal logs NEVER show:
# - Full WhatsApp phone numbers or JIDs
# - Bearer tokens or API keys
# - Full meal photo base64 strings
```

---

## 14. Safe Update & Redeploy Procedure

To deploy approved git commits to the VPS without risking WhatsApp credentials:

```bash
# From VPS repository root:
sudo -u clawfit bash deploy/openclaw/redeploy.sh main
```

The script executes:
1. `git fetch && git checkout main && git pull --ff-only`
2. `pnpm install --frozen-lockfile`
3. `pnpm build`
4. `pnpm openclaw:plugin:validate`
5. `sudo systemctl restart clawfit-openclaw`
6. `openclaw channels status --channel whatsapp --probe`

### Rollback Procedure
If an issue arises, roll back immediately to the previous approved commit:
```bash
sudo -u clawfit bash deploy/openclaw/redeploy.sh 6f028d5
```

---

## 15. Obsolete Vercel API Integration Removal

The repository previously tested deploying the Fastify API to Vercel (prior to commit `e7b7b60`), which caused routing ambiguity:
1. In the Vercel Dashboard, inspect all projects.
2. If an obsolete project named `claw-fit-api` or pointing to `apps/api` exists, open **Project Settings -> Advanced -> Delete Project**.
3. Confirm that only `claw-fit-web` (pointing to `apps/web`) remains on Vercel.
4. Verify repository root contains no `vercel.json` routing rules for the API.

---

## 16. Manual WhatsApp Acceptance Test Checklist (Post-Stage 3)

Execute after live deployment with real WhatsApp accounts. Do not mark tests passed until verified against the live environment.

| Test ID | Scenario | Status | Expected Outcome |
|---|---|---|---|
| **MAT-01** | Primary DM routing | `[PENDING]` | Message from Primary user in bot DM routes strictly to Primary profile. |
| **MAT-02** | Partner DM routing | `[PENDING]` | Message from Partner user in bot DM routes strictly to Partner profile. |
| **MAT-03** | Primary group meal | `[PENDING]` | Meal logged by Primary in shared group increments Primary totals only. |
| **MAT-04** | Partner group meal | `[PENDING]` | Meal logged by Partner in shared group increments Partner totals only. |
| **MAT-05** | Simultaneous drafts | `[PENDING]` | Simultaneous meal messages in group create two independent pending drafts. |
| **MAT-06** | Independent confirm | `[PENDING]` | Primary confirming their draft leaves Partner's draft intact and unconfirmed. |
| **MAT-07** | Partner confirm | `[PENDING]` | Partner confirming their draft creates meal record under Partner userId. |
| **MAT-08** | Simultaneous workouts | `[PENDING]` | Both users start workouts concurrently without conflict. |
| **MAT-09** | Unknown sender | `[PENDING]` | Unrecognized sender is rejected: "This WhatsApp account isn't linked...". |
| **MAT-10** | Unauthorized group | `[PENDING]` | Bot added to unapproved group rejects all health commands. |
| **MAT-11** | Service restart | `[PENDING]` | `systemctl restart clawfit-openclaw` preserves WhatsApp link without QR. |
| **MAT-12** | Host reboot | `[PENDING]` | `sudo reboot` VPS resumes OpenClaw gateway automatically without QR. |
| **MAT-13** | Backend durability | `[PENDING]` | Meal logged -> Gateway restarted -> Meal persists authoritatively in DB. |
| **MAT-14** | API outage behavior | `[PENDING]` | During API outage, bot fails closed safely with no alternate local store. |
