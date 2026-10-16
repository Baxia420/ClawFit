# ClawFit stabilization acceptance

Scope: reliable meal estimation/failure reporting and a text-first exercise
browser. No schema migration, historical import, billing change, model selection,
pairing change, or new external media source is required by this release.

## Nutrition recovery and evidence

The read-only Google nutrition request can retry once for HTTP 408, 429, 500,
502, 503 or 504, a network TypeError, or a timeout. Retries wait 500–999 ms with
jitter, respect Retry-After up to two seconds, and share a 22-second deadline
across configured models. Each HTTP attempt has at most 12 seconds. Long quota
cooldowns, credential/client errors, and malformed or blocked generation are not
retried on the same model. Existing configured fallbacks may still be tried
within the shared deadline. Meal writes are never part of this retry loop.

API startup logs `[clawfit-nutrition]` records containing the safe model ID,
attempt number, elapsed time, HTTP status, and allowlisted provider status.
Successful transport records include available input/output/thinking/total token
counts. These are operational logs, not a persistent billing ledger. They cover
the nutrition client only; Gateway token usage is separate. No prompts, photos,
provider messages, credentials, or raw output are included. Schema validation
still happens after transport; an HTTP 200 alone is not an accepted estimate.

Successful WhatsApp estimate replies are formatted from the validated Health API
result, retaining calorie ranges, confidence, uncertainty and logging state.
Model-written final text cannot substitute different numbers or claim an online
lookup. Source questions about nutrition explain the estimator's actual inputs.
This estimator has no search or external food-database access. A legible supplied
label can inform it; an unlabeled product remains an estimate. Printed-label
extraction is model-based and should still be checked by the user.

Web-search smoke evidence now retains a safe failure reason (HTTP status,
missing grounded sources, timeout, or invalid response). It still does not enable
search without successful grounding evidence. Readiness checks explicitly say
that they check configuration, not live nutrition generation or delivery.

## Automated acceptance

Run `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and
`pnpm openclaw:plugin:validate`. With Chromium installed, run
`pnpm test:library:browser`. The browser test uses isolated synthetic users and a
local Health API; screenshots can be captured with `CLAWFIT_SCREENSHOT_DIR`.

Regression coverage includes provider recovery/exhaustion, cooldowns, shared
deadline, malformed output, safe diagnostics, source reporting, canonical reply
values, no-save behavior, terminal failure notices, trusted multi-image binding,
confirmation without re-estimation, user isolation, favorites, custom editing,
plan replacement, mobile filter controls, and active-workout instructions.

## Live operator acceptance (manual)

Automated acceptance does not prove delivery over the real WhatsApp network.
After deploying the API, web app and CIA plugin, have each user perform one meal
estimate and confirmation, then correct the same meal. Confirm in the dashboard
that ownership is right and that the correction changes the existing record.
Use a separate estimate-only request and verify no draft is created. Send a
two/three-photo meal and verify it is estimated together. Ask whether the numbers
were looked up online and verify the explanation is honest. Test provider
failure through injected automated responses, not repeated live quota exhaustion.

For workouts, search, open instructions, add an exercise to a plan, replace one,
and inspect history on desktop and mobile. Check that no empty image panels
appear and that existing sets, targets and history remain intact.

Stop this release when required automated checks and those live workflows pass.
Defer Android, a full media catalogue, product lookup, and broader autonomous
tools. Provider availability, photo-estimation uncertainty and missing exercise
demonstrations remain explicit limitations. Enabling billing does not remove
those limitations.
