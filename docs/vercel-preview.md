# ClawFit Vercel Preview runbook

This runbook creates a private Preview environment without changing the local Docker/PostgreSQL setup and without promoting a Vercel Production deployment.

## Deployment topology

```text
Browser -> protected Next.js Preview -> bearer-authenticated Fastify Preview -> Neon PostgreSQL
OpenClaw/WhatsApp ---------------------> bearer-authenticated Fastify Preview -> Neon PostgreSQL
```

Create two Vercel Projects from the same repository:

| Project | Root Directory | Framework | Build settings |
| --- | --- | --- | --- |
| `clawfit-web-preview` | `apps/web` | Next.js | Keep Vercel defaults; no custom output directory |
| `clawfit-api-preview` | `apps/api` | Fastify | Keep Vercel defaults; `src/server.ts` is the zero-config entrypoint |

For both projects:

1. Set Node.js to `24.x` (also pinned in each app package).
2. In Settings -> Build and Deployment -> Root Directory, verify **Include source files outside of the Root Directory in the Build Step** is enabled. This is required for `packages/*`, the root `pnpm-lock.yaml`, and `pnpm-workspace.yaml`.
3. Do not override Install Command, Build Command, or Output Directory unless Vercel's detected defaults fail. The pnpm workspace and both frameworks are natively detected.
4. Keep the projects on separate Vercel domains. `HEALTH_API_URL` joins them server-to-server.

No `vercel.json`, route rewrite, or custom function shim is required. Vercel supports the existing Next.js app and recognizes `apps/api/src/server.ts` as a Fastify entrypoint.

## Preview environment variables

Add these only to the **Preview** environment unless and until a separate production rollout is approved. Mark credentials as Sensitive where Vercel offers that option.

### API project (`clawfit-api-preview`)

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon **pooled** runtime connection string (`-pooler` hostname) |
| `HEALTH_API_TOKEN` | yes | One long random token; exactly the same value used by Web and OpenClaw |
| `GEMINI_API_KEY` | yes for difficult/photo estimates | Existing Google API key |
| `NUTRITION_MODEL_PRIMARY` | yes for difficult/photo estimates | Only a model ID verified by `pnpm models:smoke` |
| `NUTRITION_MODEL_FALLBACK` | optional | Only a fallback ID verified by `pnpm models:smoke` |
| `APP_TIMEZONE` | yes | `Asia/Kuala_Lumpur` |

Do not add `HEALTH_API_URL` to the API project. Do not commit either Neon connection string.

### Web project (`clawfit-web-preview`)

| Variable | Required | Value |
| --- | --- | --- |
| `HEALTH_API_URL` | yes | API Preview origin, for example `https://clawfit-api-preview-abc.vercel.app` |
| `HEALTH_API_TOKEN` | yes | Same token as the API project |
| `APP_TIMEZONE` | recommended | `Asia/Kuala_Lumpur` |

These are server-only variables. Do not create `NEXT_PUBLIC_HEALTH_API_TOKEN`, `NEXT_PUBLIC_DATABASE_URL`, `NEXT_PUBLIC_GEMINI_API_KEY`, or any other browser-exposed secret.

Environment-variable edits apply only to new deployments, so redeploy both projects after any change.

## Neon preview database

1. In Neon, create a dedicated project or branch and a blank database such as `clawfit_preview`. Keep it separate from the local Docker database.
2. From Neon **Connect**, copy two URLs:
   - pooled URL for the API's Vercel `DATABASE_URL`;
   - direct/unpooled URL for migrations, `pg_dump`, and `pg_restore`.
3. Apply all committed migrations to the blank hosted database from the repository root. This changes Neon only:

```powershell
$env:CLAWFIT_NEON_DIRECT_URL = '<Neon direct/unpooled URL>'
$env:DATABASE_URL = $env:CLAWFIT_NEON_DIRECT_URL
pnpm db:migrate
Remove-Item Env:DATABASE_URL
```

4. Verify the migration ledger and scoped column before importing data:

```powershell
psql $env:CLAWFIT_NEON_DIRECT_URL -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;'
psql $env:CLAWFIT_NEON_DIRECT_URL -c 'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = ''pending_meal_estimates'' AND column_name = ''scope_key'';'
```

### Optional safe local-data copy

Exporting is read-only for the local database. Migrate the blank Neon database first, then restore **public data only** so the committed migrations remain the hosted schema authority.

```powershell
New-Item -ItemType Directory -Force -Path .\output\neon-preview | Out-Null
$env:CLAWFIT_LOCAL_DATABASE_URL = '<local PostgreSQL URL>'
pg_dump --dbname=$env:CLAWFIT_LOCAL_DATABASE_URL --format=custom --data-only --schema=public --exclude-table-data=public.pending_meal_estimates --no-owner --no-privileges --file=.\output\neon-preview\clawfit-data.dump
pg_restore --list .\output\neon-preview\clawfit-data.dump
pg_restore --dbname=$env:CLAWFIT_NEON_DIRECT_URL --data-only --no-owner --no-privileges --exit-on-error .\output\neon-preview\clawfit-data.dump
```

Pending meal drafts are intentionally excluded: they are unconfirmed, expire after two hours, and the pre-scope local table cannot be safely treated as cross-client authority. Finish or discard any active draft before cutover. Durable meals, workouts, settings, preferences, and presets remain in the data-only archive.

Do not use `--clean`, `--create`, `DROP`, or a pooled Neon URL in this workflow. Inspect row counts on both databases before considering the copy complete. Keep the dump under ignored `output/`, then remove it securely when it is no longer needed because it contains personal health data.

## Security settings

1. On `clawfit-web-preview`, open Settings -> Deployment Protection and enable **Vercel Authentication** with **Standard Protection** (or Preview-only protection if that legacy option is what the account exposes). Only approved Vercel users should open the personal dashboard.
2. Leave the API Preview reachable by the Next.js server and OpenClaw. Its `/health` and `/ready` probes are public; every `/v1/*` data/model route requires the constant-time checked `Authorization: Bearer <HEALTH_API_TOKEN>` header.
3. Do not enable Vercel Authentication on the API unless a separate protection-bypass credential and header are deliberately added to both server clients. Otherwise Vercel's login layer will block Web and OpenClaw before Fastify can validate the bearer token.
4. Review Vercel Function logs for failures. The clients show concise availability errors; server logs keep diagnostics without logging bearer tokens, Gemini keys, request images, or database credentials.

## Create the Preview deployments

Vercel treats the configured Production Branch (normally `main`) as Production. To guarantee a Preview first, create a non-production Git ref at the already-pushed `main` commit:

```powershell
git push origin HEAD:vercel-preview
```

Then, for each project in the Vercel Dashboard:

1. Open the project -> Settings -> Environments -> Production -> Branch Tracking and confirm `main` remains the Production Branch. Do not deploy or promote `main`.
2. Add the Preview variables above.
3. Verify the Root Directory and outside-root-source toggle.
4. Open Deployments -> **Create Deployment**.
5. Enter the branch `vercel-preview` (or its exact commit SHA), choose the branch configuration when prompted, and select **Create Deployment**.
6. Deploy the API first. Open its `/health`, then `/ready`. A ready response confirms database connectivity.
7. Copy the API Preview origin into the Web project's Preview `HEALTH_API_URL`, then create/redeploy the Web Preview.
8. Confirm both deployment records say **Preview**, not Production. Do not click **Promote**.

If the projects do not exist yet, import the same Git repository twice, select the two Root Directories above, and ensure the first code deployment uses `vercel-preview`. If the import screen cannot select a non-production ref, create/link the empty projects first and use Deployments -> Create Deployment rather than accepting an initial `main` deployment.

## Preview verification

With `$api` set to the API Preview origin:

```powershell
$api = 'https://<api-preview>.vercel.app'
Invoke-RestMethod "$api/health"
Invoke-RestMethod "$api/ready"
Invoke-WebRequest "$api/v1/settings" -SkipHttpErrorCheck | Select-Object StatusCode
$headers = @{ Authorization = "Bearer $env:HEALTH_API_TOKEN" }
Invoke-RestMethod "$api/v1/settings" -Headers $headers
```

The unauthenticated settings request must be `401`; the authenticated request must return settings. In the protected Web Preview, test dashboard reads, settings writes, Ask ClawFit, photo estimation, and PWA installation. The service worker may cache only `/manifest.webmanifest` and `/icon.svg`; no health/API response is cached.

For the multi-client regression, create an unconfirmed meal draft in WhatsApp and another in Web. “Log it” in Web must confirm only the Web draft. Then confirm in WhatsApp and verify that it confirms only that peer's draft. An active workout should remain visible and writable from both clients because workout state is intentionally shared.

## Switch OpenClaw without relinking WhatsApp

1. Keep the existing `HEALTH_API_TOKEN` unchanged and set the local root `.env` `HEALTH_API_URL` to the API Preview origin.
2. Run:

```powershell
pnpm openclaw:setup
openclaw gateway restart
openclaw plugins inspect clawfit-health --runtime --json
```

`pnpm openclaw:setup` copies the existing token and new API origin into `%USERPROFILE%\.openclaw\.env` without printing their values and updates only the health plugin URL/tool allowlist. Do not run `openclaw channels logout`, `openclaw channels login`, or change WhatsApp pairing/DM/group policies. The existing linked-device session remains intact.

Test `what have I eaten today?`, one unconfirmed meal plus `log it`, and the current active workout. To return to local development, restore `HEALTH_API_URL=http://127.0.0.1:4000`, rerun `pnpm openclaw:setup`, and restart the Gateway.

## References

- [Vercel Fastify zero-configuration entrypoints](https://vercel.com/docs/frameworks/backend/fastify)
- [Vercel monorepo Root Directory guidance](https://vercel.com/docs/monorepos/monorepo-faq)
- [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- [Vercel Preview environments](https://vercel.com/docs/deployments/environments)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [Neon migration guidance](https://neon.com/docs/import/migrate-intro)
