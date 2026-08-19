# ClawFit v1 deployment

ClawFit v1 uses one authoritative hosted Health API and database for both clients:

```text
WhatsApp -> OpenClaw -----------\
                                  Render Health API -> Neon PostgreSQL
Browser -> Vercel Next.js app --/
```

The Fastify API is intentionally deployed to Render, not Vercel. The earlier Vercel API experiments ended at commit `e7b7b60` and are not part of this runbook.

## 1. Neon connection strings

In the Neon dashboard, open the ClawFit project and use **Connect** to copy both connection strings without pasting either into chat, source control, screenshots, or logs:

- **Pooled** (`-pooler` hostname): Render's runtime `DATABASE_URL`.
- **Direct/unpooled**: migrations only.

Keep the existing local `.env` unchanged while migrating Neon. From the repository root:

```powershell
$env:CLAWFIT_NEON_DIRECT_URL = '<direct Neon URL>'
$clawfitPreviousDatabaseUrl = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
$env:DATABASE_URL = $env:CLAWFIT_NEON_DIRECT_URL
pnpm db:migrate
if ($null -eq $clawfitPreviousDatabaseUrl) {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
} else {
  $env:DATABASE_URL = $clawfitPreviousDatabaseUrl
}
Remove-Item Env:CLAWFIT_NEON_DIRECT_URL -ErrorAction SilentlyContinue
```

## 2. Render Health API

Create a Render Blueprint from this repository's root `render.yaml`, or configure an equivalent Web Service manually:

| Setting | Value |
| --- | --- |
| Name | `claw-fit-api` |
| Branch | `main` |
| Runtime | Node |
| Root Directory | blank / repository root |
| Build | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @clawfit/api build` |
| Start | `pnpm --filter @clawfit/api start` |
| Health check | `/ready` |

The repository root is required because the API imports `packages/db` and `packages/health-core` from the pnpm workspace.

Provide these sensitive values in the Render dashboard when the Blueprint prompts for them:

- `DATABASE_URL`: Neon pooled URL.
- `HEALTH_API_TOKEN`: the same long token used by Web and OpenClaw.
- `GEMINI_API_KEY`: existing key.
- `NUTRITION_MODEL_PRIMARY`: only a model verified by `pnpm models:smoke`.
- `NUTRITION_MODEL_FALLBACK`: optional verified fallback.

The Blueprint sets `HOST=0.0.0.0`, `APP_TIMEZONE=Asia/Kuala_Lumpur`, and Node 24.15.0. Do not set `PORT`; Render supplies it.

Verify the deployed origin:

```powershell
$clawfitApiOrigin = 'https://<render-service>.onrender.com'
Invoke-RestMethod "$clawfitApiOrigin/health"
Invoke-RestMethod "$clawfitApiOrigin/ready"
Invoke-WebRequest "$clawfitApiOrigin/v1/settings" -SkipHttpErrorCheck | Select-Object StatusCode
$clawfitHeaders = @{ Authorization = "Bearer $env:HEALTH_API_TOKEN" }
Invoke-RestMethod "$clawfitApiOrigin/v1/settings" -Headers $clawfitHeaders
```

Expected results are `ok`, `ready`, `401`, then the settings payload. If `/health` works but `/ready` fails, check `DATABASE_URL` and run the Neon migrations with the direct URL.

## 3. Vercel web app

Import the same GitHub repository as a separate Vercel project:

| Setting | Value |
| --- | --- |
| Project | `claw-fit-web` |
| Root Directory | `apps/web` |
| Framework | Next.js |

Enable access protection appropriate for this private health dashboard. Add server-only variables:

- `HEALTH_API_URL=https://<render-service>.onrender.com`
- `HEALTH_API_TOKEN=<same token as Render and OpenClaw>`
- `APP_TIMEZONE=Asia/Kuala_Lumpur`

Never create `NEXT_PUBLIC_` versions of secrets. Redeploy after changing environment variables.

## 4. OpenClaw cutover

Update only `HEALTH_API_URL` in the local root `.env` to the Render origin. Keep the existing API token and WhatsApp authentication. Then run:

```powershell
pnpm openclaw:setup
openclaw gateway restart
openclaw channels status --channel whatsapp --probe --json
openclaw config get tools.alsoAllow --json
```

The probe must remain linked, connected, and healthy. The tool list must include `create_pending_meal`. Do not log out or run QR pairing for this cutover.

## 5. Cross-client acceptance test

1. Load Today, Nutrition, Workouts, Settings, and one exercise-history page in the deployed web app.
2. Create separate unconfirmed meal drafts in Web and WhatsApp. Confirming Web must not confirm the WhatsApp draft, and vice versa.
3. Retry each confirmation once and verify no duplicate meal is created.
4. Start a workout in one client and read/add to it from the other; workout state is intentionally shared.
5. Test a food photo without confirming it unless the entry is wanted.
6. On iPhone Safari, open the Vercel URL and use **Share -> Add to Home Screen**. Launch the installed app and repeat a read plus one harmless draft/cancel flow.

PostgreSQL and the Health API remain authoritative throughout. Chat history and browser caches are never used as the source of truth.
