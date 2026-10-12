# Photo and training hotfix, October 12

## Evidence and changes

On `5fa8df3`, the ordinary nutrition tool exposed `imagePath` and `imagePaths`. A model-supplied URI took precedence over trusted inbound paths. Real references containing literal slashes inside `media://inbound/` were rejected by the resolver. The resolver's traversal checks remain intact; the tool now accepts only `text` and selects all photos exclusively from current trusted attachment metadata. Missing or mismatched sender, conversation, session or account context fails safely. An event that identifies a photo without a usable trusted path cannot degrade into text-only inference.

Render recorded HTTP 503 for `/v1/nutrition/estimate` at 08:04:31 Kuala Lumpur time. Later successful requests at 08:39:34 and 08:39:42 recorded `imageCount: 0`. These logs establish a failed estimate and later text-only inference; they do not establish why the model service was unavailable or whether every subsequent number came from the general agent.

The previous final-reply hook marked any final text as delivered even after a tool failure. It now replaces failed-turn final payloads with the safe error message and suppresses duplicates. Retry and meal-write blocks remain enforced. Duplicate calls for one trusted inbound album share an in-flight promise/result, avoiding repeated image reads and nutrition requests. User captions and quantities are included ahead of the general agent's description.

Workout API calls for active workouts, history and plans returned HTTP 200 while the page displayed its general error boundary. `TrainingHub`, a client component, imported its date formatter from the server API module, which also imports authentication and requires private configuration. Browser-safe date functions now live in `lib/dates.ts`. The server wrapper retains its configured timezone default. The regression renders all four tabs without mocking authentication and with no server secrets.

## Validation and deployment

Regression coverage includes trusted filesystem image bytes through the registered plugin, authenticated API and real estimator implementation with a fake model client; both literal-slash URI examples; unavailable attachments; rejected model paths/bytes; ownership and cache isolation; two-image forwarding and concurrent duplicate calls; failed-turn guessed-number suppression; no-save behavior; and the empty active-workout JSON response. Resolver traversal, symlink, image-format and size tests remain in the suite.

Use the existing `deploy/openclaw/redeploy.sh` with the published commit on CIA. It updates the repository-built plugin and restarts the existing gateway; do not apply a separate CIA source patch. This environment has no CIA SSH connection, so an operator on CIA must execute that script. If its verified-model-report preflight fails, inspect the reported reason before proceeding; do not reset pairing, secrets or identities.

After the gateway update, the authorized participant should send one fresh food photo and then a two-photo album. Confirm the nutrition response and Render's corresponding `imageCount: 1`/`2` records. A no-save request must create no draft or logged meal. No live Gemini calls or WhatsApp sends are part of automated tests. The existing API implementation already forwards images to the dedicated estimator; this hotfix changes the plugin and web client, and needs no database migration or credential change.

## Key capacity, analysis only

The API currently uses one `GEMINI_API_KEY` for its configured nutrition models. A 503 alone does not identify daily quota exhaustion. Google documents limits per project, not per API key, and advises checking the active model limits in AI Studio: https://ai.google.dev/gemini-api/docs/rate-limits. Rotating keys in the same project will not increase its quota. A future design should track the supplying project and model, cap concurrency, distinguish temporary provider failures from exhausted quota, and avoid repeated attempts against an exhausted allocation. No key rotation, model change or credential update is implemented here, and the reported 20/day limit has not been independently verified against this account.
