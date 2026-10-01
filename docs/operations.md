# ClawFit operations and service directory

Last reviewed: 1 October 2026 (Asia/Kuala_Lumpur). Live observations below come from the operator's Render, Neon, and UptimeRobot screenshots; configuration details come from the repository. Recheck this page after changing a service.

## Where to go

| Component | Link | What it does / what to check |
|---|---|---|
| Repository | [Baxia420/ClawFit](https://github.com/Baxia420/ClawFit) | Code, changes, and these docs. |
| API | [Public health endpoint](https://clawfit.onrender.com/health) | Confirms that the API process responds; does not query Neon or prove database readiness. |
| API hosting | [Render dashboard](https://dashboard.render.com/) | Open the service serving `clawfit.onrender.com`. Check deploy commit, logs, environment variables, and Settings → Health Check Path. The Blueprint's name is `claw-fit-api`; the observed hostname is `clawfit.onrender.com`. |
| External monitor | [UptimeRobot: ClawFit API](https://dashboard.uptimerobot.com/monitors/803929689) | Exact monitor page confirmed in the screenshot. Requires the operator's signed-in account. |
| Database | [Neon console](https://console.neon.tech/) | Select the ClawFit project and production branch. Check compute status, scale-to-zero settings, and CU-hour usage. The project-specific URL has not been recorded. |
| Web dashboard hosting | [Vercel dashboard](https://vercel.com/dashboard) | The deployment runbook places the Next.js client here. The live project and public dashboard URL need confirmation. |
| WhatsApp gateway | OpenClaw host | Runs the WhatsApp connection and health plugin. Record the current host and access method after verifying them; the existing deployment runbook describes a VPS template and is not proof of the current host. |

For first installation, secrets, identity linking, backups, and redeployment commands, use [the deployment runbook](deployment.md). For user routing, use [identity and multi-user docs](identity-and-multi-user.md).

## Monitor settings to preserve

The UptimeRobot screenshot on 1 October 2026 confirms:

| Setting | Observed value |
|---|---|
| Monitor name | ClawFit API |
| Type | HTTP/S |
| URL | `https://clawfit.onrender.com/health` |
| Interval | Every 5 minutes |
| Status at observation | Up |

Keep Render's own **Health Check Path** set to `/health` too. Render probes and UptimeRobot checks are separate configurations; changing one does not update the other.

UptimeRobot's incoming requests are intended to keep the free Render API responsive while Neon can suspend between real operations. Successful checks also confirm that the API process is reachable. They do not verify WhatsApp connectivity, database access, or model availability.

If the API hostname changes, update this monitor URL, this directory, and both API clients' `HEALTH_API_URL` settings. The monitor uses the public health endpoint and needs no machine bearer token.

## What wakes the database

| Operation | Database access | Usage |
|---|---|---|
| `GET /health` or `HEAD /health` | None | Recurring Render and UptimeRobot checks. |
| Unauthenticated `/ready` | None; returns 401 | Not a useful uptime check. |
| Authorized `GET /ready` | Checks database and schema | One-shot operator diagnostic; intentionally wakes Neon. |
| API startup | Checks database/schema before listening | Deploys and restarts can wake Neon once. |
| Meal, nutrition, workout, identity, or settings operations | Reads or writes PostgreSQL | Expected activity when ClawFit is used. |
| SQL editor, Drizzle Studio, migrations, or another database client | Can connect/query directly | Can wake Neon independently of the API. |

The pool closes unused connections after 30 seconds and reconnects when needed. Neon suspension follows its own inactivity setting; the pool timeout is not the Neon sleep timeout.

Do not schedule `/ready`, `pnpm nutrition:smoke`, or authenticated nutrition endpoints as keep-alive checks. Notification settings currently store rules only; the repository does not implement a notification delivery worker. External OpenClaw cron and heartbeat configuration must be checked on its host separately.

## What happens to a WhatsApp daily lookup

The agent calls `get_daily_nutrition`. The plugin requests `/v1/nutrition/daily`, the API reads that user's meals for the local calendar date, and code adds up their saved nutrition. The lookup does not rerun the nutrition estimator. The agent may still use a model to select the tool and write the reply.

If Neon is asleep, the database connection wakes it automatically. Neon describes typical wake-up latency as a few hundred milliseconds; this is a provider expectation, not a measured ClawFit end-to-end response time. If the free Render API also sleeps, Render describes approximately a minute to restart after a request. The five-minute monitor is intended to avoid that API delay.

The plugin defaults to a 30-second fetch timeout when no upstream signal is supplied. A paused or failing monitor can allow Render to sleep, so the first request may then time out. An upstream signal can change that timeout.

References: [Neon compute management](https://neon.com/docs/manage/endpoints/) and [Render service behavior](https://render.com/docs/faq#why-is-my-free-service-sometimes-slow-to-respond).

## Check idle usage without generating new traffic

1. Confirm UptimeRobot uses `/health` every five minutes and Render's Health Check Path is `/health`.
2. Leave the web dashboard unused. Stop local servers and database tools. Do not run a readiness probe, SQL query, migration, or WhatsApp health operation during the observation window.
3. Wait at least six minutes after the last database operation when Neon is configured to suspend after five minutes.
4. Look at Neon compute status and the monitoring timeline. Expect **Inactive** and **0 allocated CU** despite successful UptimeRobot checks. Usage totals may update later.
5. When an end-to-end check is needed, send one WhatsApp daily lookup, verify the reply, and then allow another idle window.

A 1 October screenshot showed Neon **Inactive / 0 allocated CU**, confirming suspension at that observation. A full WhatsApp wake-up round trip has not been measured in this audit.

At 0.25 CU, four active hours use approximately one CU-hour. Continuous operation for a 31-day month uses 186 CU-hours. An occasional real lookup will still use compute, including the active interval before suspension.

## Quick troubleshooting

| Symptom | First checks |
|---|---|
| Monitor is down | Open its recorded monitor page; check URL and paused state, then Render deploy status and request logs. |
| Monitor is up, but WhatsApp fails | Check OpenClaw channel/host logs and the failed API request. A healthy process does not prove database or model readiness. Use authorized `/ready` once if needed. |
| Neon stays active with no users | Look for repeated `/v1/*` requests, authorized readiness checks, or API restarts in Render logs; then check external jobs and direct database clients. |
| First reply is slow | Confirm the monitor is running and whether Render slept. Measure an actual request before attributing the delay to Neon or the model. |
| Monitor uptime looks poor after the fix | Check incident dates. The screenshot contains historical downtime; a past aggregate does not describe current database health. |

Inspecting Neon's active SQL sessions is itself database activity. Do it deliberately when investigating a persistent problem, rather than polling it throughout an idle test.

## Deployment record and maintenance

On 1 October 2026, [PR #1](https://github.com/Baxia420/ClawFit/pull/1) merged as `32256f73b185b6d4f3907c8128d7811e76d7c4fe`. The supplied Render screenshot confirmed that commit deployed successfully. The change moved routine platform checks to `/health`, protected `/ready`, and added the 30-second idle connection timeout. The confirmed source of unnecessary database activity was the previous Render `/ready` probe. The external UptimeRobot monitor shown later already used `/health`.

After changing hosting, monitors, endpoints, or credentials, update this page in the same PR. Record the verified service URL, monitor interval, health-check path, deployment commit, and verification date. Keep tokens, database connection strings, WhatsApp identities, and session credentials out of the docs.

The current OpenClaw host, Vercel project/public URL, project-specific Render/Neon console links, and monitor alert recipients remain to be recorded after verification.
