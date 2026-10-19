# Google credential failover (prepared, not activated)

This change is prepared separately from the October 19 workflow release
`3843f889ef0fc2368e2bbbe005de5dac00080189`. Do not merge or deploy it until the
operator finishes observing that release and gives a new go-ahead. No live
credentials, production configuration, hosting settings, schema, historical
records, or WhatsApp pairing are changed by preparing this branch.

## Protected configuration

Keep the existing `GEMINI_API_KEY`. Add backups as `GEMINI_API_KEY_1` through
`GEMINI_API_KEY_8`, one key per distinct Google project. The operator has already
verified that the existing projects have the same limits and model access.
Identical key values are deduplicated; different keys belonging to the same
project cannot be detected locally and do not provide independent quota.

On CIA, edit `/home/clawfit/.openclaw/.env` as the service user using the existing
protected-file workflow. Keep mode 600 and service-user ownership. On the Health
API, enter the intended slots in its protected service environment. These are
separate processes: changing one does not configure the other. Do not put keys
in chat, git, command arguments, browser variables, or reports. Blank backup
slots are ignored. Retain slot numbers for stable diagnostic labels. Remove a
slot from the protected environment to retire it, then reconfigure/restart.

`openclaw:setup` synchronizes missing slots from local development settings while
preserving values already in the protected file. `models:configure` registers
`google:clawfit-primary`, `google:clawfit-backup-1`, etc. through the pinned
OpenClaw SDK. Its per-agent auth store contains environment references, not key
copies. Existing non-managed credentials and retained cooldown state are
preserved. The managed Google order excludes unrelated profiles. Removed managed
slots are pruned from that order and store.

## Gateway behavior

The Gateway keeps the smoke-verified Gemini Flash-Lite model. Native OpenClaw
profiles provide same-model credential failover, eligibility checks, cooldowns,
and session affinity. Configuration removes the explicit single provider key,
disables general model fallbacks, and removes Gemma from the configured Google
model registry and default allowlist. Old reports selecting Gemma as fallback
are accepted without re-enabling it; a report selecting Gemma as primary is
rejected. Fresh smoke probes do not call Gemma.

The pinned `2026.7.1-2` host's `rateLimitedProfileRotations: 1` limits rotation
*before model fallback*. With no model fallback, the host may try all eligible
profiles. The offline runtime test verifies this with three failing profiles.
The existing ClawFit turn guards remain in effect: 60 seconds of processing,
eight model starts, sixteen tool calls, and at most two seconds of delivery
drain. Credentials do not grant a new turn budget or authorize replaying writes.
Cooldown details follow the pinned host's native implementation; the nutrition
client's daily-reset parser below does not modify Gateway cooldown rules.

If an existing session was manually pinned to Gemma, select the configured
default through OpenClaw before using it again. Do not reset pairing or delete
conversation history. The preflight checks configuration, profile references,
and routing, but cannot prove live quota failover or device-side delivery.

## Nutrition behavior

The API selects a healthy credential for each configured nutrition model and
retains it after success. On HTTP 429, it cools the failed slot for that model
and can try a different slot with the exact same prompt, images, and model.
Each `generate` call has at most two HTTP attempts, including ordinary network
or transient-server retries. There is no extra attempt allowance per key. The
estimator's existing shared 22-second deadline, per-model time allocation, and
30-second Gateway HTTP timeout remain in effect. A configured nutrition model
fallback remains available within that shared deadline.

Cooldown parsing uses `Retry-After` and structured Google `RetryInfo` details,
with 60 seconds as a conservative fallback when no usable hint exists. A
structured daily quota violation waits until at least the next midnight in
`America/Los_Angeles`, including daylight-saving changes. Raw error messages are
not used to infer quota scope and are not logged. Longer explicit retry hints
are preserved. Unknown quota scope is reported as unknown, not guessed daily.

HTTP 400/401/403/404, malformed generation, and safety blocks do not cycle keys
for that request. A 401 disables that credential in the API process until
credentials/configuration are corrected and the process restarts. Concurrent
success cannot erase another request's cooldown. When the pool is exhausted,
new requests fail promptly instead of hammering known exhausted credentials.
Only model-generation calls are retried; no meal write endpoint is replayed.

Safe nutrition diagnostics include slot ID, model, attempt, status, token counts
when available, quota scope, and cooldown expiry. They exclude key values,
account emails, raw provider errors, prompts, and photo bytes.

The API pool is process-local and its cooldowns reset on restart. Gateway state
is managed by OpenClaw. There is no cross-process quota broker: if both use the
same projects, Google counts their combined usage and each component learns
about throttling from its own responses. This does not promise aggregate quota,
reserve capacity, or solve a provider-wide outage. Web-search tool routing is
outside the tested agent-generation and nutrition paths.

## Checks and later activation

Automated checks use fake credentials and responses. Native replay runs the
actual pinned auth store, secret-reference resolver, and agent retry loop in an
isolated temporary state directory, with both sockets and fetch blocked.
It covers primary rejection followed by successful backup on the same model,
all-profile exhaustion, persisted cooldowns, and idempotent profile setup.

After the observation period, review the PR and provide the merge/deployment
go-ahead. Then configure protected slots separately, deploy the API, and run the
existing pinned-commit CIA redeploy workflow. The workflow stops the Gateway
before applying model/profile configuration and keeps pairing intact. No schema
migration or historical rerun is required. Single-key operation remains valid.

Optional explicit live verification: `pnpm models:smoke --credential backup-1`
uses that slot and writes `.model-smoke-backup-1.json`. It makes real Google
requests and is never part of automated tests or automatic setup. Backup reports
do not overwrite the primary `.model-smoke.json` used for model selection.

Compare normal use after activation against the existing October 19 baseline:
same-model recovery count, final failures, turn latency, model calls and tokens,
and actual meal/draft outcomes. Keep the earlier revision and protected config
backup for rollback. An application rollback never undoes completed meal writes.
