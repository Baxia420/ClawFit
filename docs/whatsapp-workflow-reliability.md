# WhatsApp workflow reliability

This release repairs application behavior without moving hosting, changing model
IDs or credentials, upgrading OpenClaw, resetting WhatsApp pairing, or rerunning
historical imports. No schema migration is required.

## Turn boundaries

- A permanent policy veto queues one reply through the original dispatcher, then
  stops the bound session. Later calls cannot acquire a new write grant.
- Confirmation comes from the channel's current command text. Quoted text and
  code blocks cannot supply consent. Ordinary affirmative variants are accepted;
  a trailing `@Clawfit` is stripped only with an explicit channel-verified bot mention.
- The plugin limits a turn to 60 seconds, eight model starts, and sixteen tool
  calls. The model-start timer retains the originating session/run and checks it
  is still current before stopping it; it cannot look up and cancel a later run.
- Termination drains the reply dispatcher for at most two seconds and marks typing
  idle. The delivery drain can extend the 60-second processing deadline by up to
  two seconds.

## Draft and meal operations

`delete_pending_meal` accepts `pendingDraftId`, not a logged meal ID. It reads the
authorized draft and uses `DELETE /v1/meals/pending/:id` with the sender's scope.
Omitting the ID is allowed only when exactly one active authorized draft exists.
An explicit cancellation request can accompany a no-save instruction; it does not
authorize any other write. Already cancelled, expired, confirmed, missing, and
ambiguous drafts have separate outcomes. A confirmed draft never causes deletion
of its logged meal.

Final action statements use operation receipts. A read cannot become a claim of
cancellation, and a nutrition reply offers confirmation only with one matching,
unexpired draft. Receipt-based replies retain earlier successful work if a later
operation fails. A network error on a write leaves its outcome uncertain, so the
reply asks the user to check existing state before retrying.

Draft creation and direct meal logging derive idempotency keys from trusted
message identity. Duplicate model calls cannot choose a new key. Confirmation and
cancellation lock the same database row to serialize their state transitions.

## Recipient boundaries

Quoted message text cannot select an owner. A retry quoting another sender, or a
quote with no verified sender, needs an explicit recipient before a draft is
created or a meal is logged. Existing household membership and scope checks still
authorize every operation. Recipient labels come from the API's verified profile
response. Recipient 403s and missing-record 404s receive specific next steps.

## Recovery and diagnostics

Nutrition retains a shared 22-second budget. When multiple verified models are
configured, the remaining time is divided among the remaining candidates so a
slow primary cannot consume the entire fallback budget. This does not configure
a new fallback or establish that a model is available on the active account.

Gateway events include a hashed run correlation, policy veto, plugin-requested
stop, model attempt, available token usage, reply preparation, and send outcome.
Send events without an exact run ID remain explicitly uncorrelated. Send
acceptance does not establish recipient-device display or decryption. Logs omit
raw message bodies, profile names, phone numbers, credentials, and image bytes.

The Health API client records allowlisted error codes and self/household route
categories, and applies its 30-second request timeout even when a caller supplies
an abort signal.

## Verification and rollout

Run `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and
`pnpm openclaw:plugin:validate`. Tests use injected provider transports and local
PGlite databases. Pinned OpenClaw replays cover the loader, CLI respawn, dispatch,
multi-photo bursts, duplicate calls, rejection loops, and failure replies without
live WhatsApp, Gemini, or production database requests.

After review, deploy the application/API changes and the Gateway plugin as two
separate components. Refresh the Gateway tool allowlist through the existing
setup/redeploy workflow so the cancellation tool is exposed. Record both deployed
revisions and retain their previous versions for rollback. Application rollback
does not undo already completed meal operations.

Real acceptance still requires both users to exercise estimation, confirmation,
correction, explicit partner logging, draft cancellation, and a safe failure,
checking persisted state and recipient-side messages together.

Hosting migration, Render infrastructure changes, provider billing, and live key
configuration remain deferred. The current API startup path accepts one
`GEMINI_API_KEY`; the Gateway's native credential profiles are separate. Before
configuring multi-project credentials, verify the selected profile/project in
each component using opaque labels, without printing keys. A batch migration's
credential setup is not evidence of the live bot's credential routing.
