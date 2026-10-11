# WhatsApp photo handoff and estimate-only behavior

## Cause

The health plugin on `2143fa2` looked for `authorizedMediaPaths`, `authContext`, and attachment arrays on the tool factory context. Those fields are not part of OpenClaw `2026.7.1-2`'s `OpenClawPluginToolContext`. Its trusted identity fields include `requesterSenderId`, `deliveryContext`, `agentAccountId`, and `sessionKey`, but not inbound attachments or `runId`. The previous successful image test supplied invented context fields and therefore did not exercise the SDK handoff.

The pinned SDK supplies the finalized inbound `MsgContext` in `reply_dispatch`. Its attachment fields include `MediaPath`/`MediaPaths`, and its identity fields include `SenderId`, `AccountId`, `SessionKey`, `MessageSid`/`MessageSidFull`, and the conversation target. `reply_dispatch.runId` is optional. The implementation captures this host event, binds the unique matching sender/conversation/session to `before_prompt_build.runId`, and binds `before_tool_call.toolCallId` to the run. The factory then verifies that binding against its trusted sender, conversation, account, and session. Missing or ambiguous context fails closed; prompts and model arguments never confer attachment ownership.

A second issue was independent of media: the guidance demanded persistence of every estimate as a pending draft. Confirmation could also be inferred from model-provided `rawUserText` or earlier prompt contents. Both are replaced with the current trusted inbound text. An explicit no-save or estimate-only request blocks pending drafts, logged meals, corrections, and food-preset writes. Ordinary estimates can still create unconfirmed drafts; logging needs current confirmation.

## Result and safeguards

- Current image paths are handed to the resolver automatically when the model omits a reference. Explicit paths or media aliases must identify exactly one current authorized attachment. No directory search can substitute another sender's file with the same basename.
- Model-supplied base64 is removed from the WhatsApp tool schema. The plugin reads the authorized attachment itself. The Health API's independent image input remains available.
- Traversal and malformed encoded IDs fail safely. Filesystem matching is case-sensitive. Every symlink path component is rejected, and a regular-file descriptor is read with a hard byte bound. The file is not re-opened between header inspection and byte forwarding.
- The four-image, per-image and aggregate byte limits remain enforced. Encoded image sizes and JSON request budgets are also checked before forwarding. MIME types come from image magic bytes.
- Media and API failures return `retryable: false` for the current turn. Subsequent executions of the failed tool are blocked before execution, including across model failover; meal writes after a failure are also blocked. Finalization cannot request another revision pass. This does not disable the host's configured model fallback or abort unrelated runs.
- The outer terminal lifecycle event supplies one clear error if no final reply was delivered. Per-attempt `agent_end` events do not trigger a premature error. Core terminal error replies queued after that fallback are suppressed, while intermediate model-fallback notices remain silent. Suppressed delivery and cross-origin routing are not overridden.
- Nutrition model exhaustion is returned by the API as a sanitized HTTP 503, including primary 503 plus fallback 429. No model diagnostics or credentials are shown to the user, and generic failure text does not claim a previous successful write was undone.
- The bridge retains bounded, ephemeral message/attachment metadata for at most 30 minutes. It does not persist image data, change pairing or credentials, write identities, or touch historical meals.

## Validation

`scripts/whatsapp-media.integration.test.ts` exercises the real registered plugin, an SDK-shaped finalized WhatsApp image event, the authenticated Fastify Health API, and the real nutrition-estimator implementation with an injected fake model client. It checks exact image bytes at the model boundary, ownership headers, first-call success, no persistence under explicit no-save instructions, stale/cross-sender/cross-account denial, model-byte injection, malformed references, traversal, symlinks, blocked retries, current-message consent, terminal outage delivery, duplicate suppression, and suppressed delivery. API routing and resolver regression tests are retained with corrected trusted inbound fixtures.

No real Gemini requests, WhatsApp sends, production schema changes, or CIA edits are part of these checks. A live WhatsApp event has not been observed in this environment; deployment still needs the user's runtime check of an authorized photo and an explicit estimate-only request.

## PR #5 compatibility and rollout hold

The fix is developed and tested on PR #5 head `46ce50b64a1d4638790a96e396c3c92922d83b80`, which is based on main `2143fa27b90b2b7fff47a09d670f3034088ff182`. PR #5 does not modify the plugin handoff. This fix adds no database schema changes and preserves the training API and workout tools.

Read-only production inspection on October 11 found all four PR #5 tables absent (`body_weights`, `training_profiles`, `workout_routines`, `workout_schedule`) and both new columns absent (`workouts.routine_snapshot`, `exercises.muscle_group`). The Render API tracks main but has auto-deploy disabled. Therefore code compatibility does not make an immediate combined production rollout safe: the web deployment would request training endpoints before the matching API/schema are available. Main must remain unchanged until that ordering is resolved, per the user's compatibility condition.

Follow `docs/training-hub.md`: recovery branch/snapshot, migration dry run against current production data, count reconciliation, journaled migration 0007, API deployment, then web deployment. The WhatsApp gateway also needs the repository-built plugin installed through its normal update flow and a restart. Do not patch a CIA copy directly, re-pair WhatsApp, reset credentials, relink identities, or re-import historical meals. The plugin build command is `pnpm openclaw:plugin:build`; validation is `pnpm openclaw:plugin:validate`.
