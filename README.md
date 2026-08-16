# ClawFit

ClawFit is a private calorie, nutrition, and workout tracker. PostgreSQL and the authenticated Health API are the source of truth; OpenClaw and the Next.js dashboard are independent clients of that API.

## Architecture

```text
WhatsApp → OpenClaw + health-tracker Skill → clawfit-health tools
                                                ↓
Dashboard ───────────────────────────────→ Health API → PostgreSQL
                                                ↓
                             synchronous Gemini nutrition estimate
```

The OpenClaw plugin exposes only health-domain tools. It does not expose SQL, shell, filesystem access, or generic HTTP requests. Meal estimates are drafts until explicitly confirmed.

## Prerequisites

- Node.js 24.15+
- pnpm 11+
- Docker Desktop (or another PostgreSQL 17 server)
- OpenClaw 2026.7.1-2 or newer
- A Google AI Studio Gemini API key

## Local setup

```powershell
Copy-Item .env.example .env
# Edit .env and set a long random HEALTH_API_TOKEN.
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

The API listens on `http://127.0.0.1:4000`; the dashboard is at `http://localhost:3000`. `pnpm dev` runs both. Data remains in the `clawfit-postgres` Docker volume across Gateway and app restarts.

Useful commands:

```text
pnpm test                 automated quota-free tests
pnpm lint                 static lint
pnpm typecheck            strict TypeScript checks
pnpm build                production builds
pnpm db:generate          generate a Drizzle migration
pnpm db:migrate           apply migrations
pnpm db:studio            inspect PostgreSQL with Drizzle Studio
pnpm models:smoke         authenticated model catalog + one-request probes
pnpm models:configure     configure only models verified by the smoke report
pnpm nutrition:manual     explicit real-API nutrition test
```

## Google models and OpenClaw

1. Put `GEMINI_API_KEY` in the root `.env`.
2. Run `pnpm models:smoke`. It reads the authenticated Google `models.list` catalog, makes no more than one minimal request per matching candidate, tests tool calling on default-model candidates, and writes a non-secret ignored report to `.model-smoke.json`.
3. Run `pnpm models:configure`. It refuses to change OpenClaw unless a default model with working tool calling and a strong nutrition model were verified.
4. Copy the reported `NUTRITION_MODEL_PRIMARY` and optional fallback IDs into `.env`.
5. Run `pnpm openclaw:setup` to build/load the local plugin, apply the least-privilege tool policy, and synchronize the required Gateway variables to `%USERPROFILE%\.openclaw\.env` without printing their values. It is safe to rerun after plugin changes.
6. Restart the API and run `openclaw gateway restart`.
7. Verify with `openclaw plugins inspect clawfit-health --runtime --json` and `openclaw security audit --deep`.

Model IDs are intentionally absent from committed OpenClaw configuration. This prevents stale or guessed IDs from being selected.

## WhatsApp manual pairing

The project uses OpenClaw’s official WhatsApp channel. With the Gateway configured, run:

```powershell
openclaw plugins install clawhub:@openclaw/whatsapp
openclaw plugins enable whatsapp
pnpm openclaw:setup
openclaw channels login --channel whatsapp
```

This is the required human-interaction point. On your phone, open WhatsApp → **Settings** → **Linked devices** → **Link a device**, then scan the live terminal QR. Start the Gateway with `openclaw gateway`, message the linked number, and approve the first DM request in OpenClaw Settings → Channels, or use:

```powershell
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

Test a text query first (`what have I eaten today?`), then a meal photo, then a workout. QR login and sender approval are separate operations.

## Nutrition behavior

- Simple quantified food and saved presets avoid the strong model.
- Difficult restaurant meals, mixed curries, hidden oil/sauce, and photos use `estimate_nutrition` synchronously.
- Estimates preserve best/low/high calories, macros, confidence, uncertainty reasons, source text, and item details.
- Nothing is logged until confirmation, unless the initial message explicitly asked to log it.
- Automated tests inject fake model clients and never consume Gemini quota.

This is a personal tracking tool, not a medical diagnosis or treatment system. Nutrition values remain estimates.

## Environment loading

The API, database migrator, and Next.js app load the repository-root `.env` even though pnpm runs workspace scripts from their package directories. Keep secrets in that single ignored file; do not create package-local copies.
