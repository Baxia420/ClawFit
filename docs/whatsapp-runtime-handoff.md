# WhatsApp runtime handoff after PR #7

## Evidence and scope

The October 12 production logs at 10:55:22, 10:55:57 and 10:56:14 MYT show `estimate_nutrition` completing in 94, 63 and 62 ms. The supplied Render inspection found no corresponding nutrition or pending-meal calls. The screenshot shows the safe-photo rejection. This establishes rejection before the Health API, but the existing gateway logs contain no binding or resolver reason code. They cannot establish which production metadata field was missing.

The plugin files on deployed `117bfcd9eabb4158b7fc26636cf3e5d568d4395d` are unchanged by PR #8. This branch starts from main `013174e5d9a328976c46ea4a3b4b3dca08dd0cc0`, preserving PR #8.

An isolated checkout of **the exact deployed commit**, using installed OpenClaw **2026.7.1-2**, reproduces a separate integration defect:

- The active plugin registration receives `reply_dispatch`, prompt and tool-call hooks.
- The host can create a separate read-only tool-discovery registration. `defineToolPlugin` captures that registration's API in the factory closure. The loader and descriptor executor support loading these separate registries.
- PR #7 stores `InboundTurns` in a `WeakMap` keyed by API object. The discovery factory sees its own empty state, even though the active hook registration bound the photo correctly.
- In the deployed-code replay, the discovery factory returns `unauthorized_media` while the active factory forwards the same authorized photo collection. No model-supplied media reference is involved.

This is a demonstrated fault in the pinned integration, not proof that CIA took this particular loader branch during all three failures. The new structured diagnostics distinguish registration state, missing identity, run/call binding and actual file-read rejection on the next live test.

## Implementation

The active `before_tool_call` hook creates an unpredictable, process-local grant for its exact turn and call. OpenClaw's actual tool wrapper forwards adjusted hook parameters to the tool's `execute` method. A bounded in-memory receipt broker, shared across plugin registrations/module copies, resolves the grant. The tool verifies call ID, tool name, session, sender, conversation, account and channel before using attachments or cached results. The internal grant is removed before schema validation and API forwarding. It is absent from the model-facing schema and results.

This avoids both registration-local state loss and reliance on tool-call IDs being unique across different runs. Missing, guessed, expired, completed or mismatched grants cannot read a photo. Missing account IDs use the pinned SDK's `default` semantics; they never match a named account as a wildcard. A trusted originating account can supply an omitted inbound account.

The existing resolver is unchanged: exact attachment ownership, traversal rejection, symlink checks, regular-file/descriptor checks, magic-byte MIME detection and byte/count budgets remain enforced. No directories, prompt strings or historical messages are searched for replacement images.

An unbound run keeps failure-only state without gaining attachments. Failed estimates block subsequent estimation/writes and replace guessed final nutrition with the safe error. API failures are normalized inside the cached promise so results can be reused safely across module instances. Draft creation waits for an in-flight estimate; failure prevents the write.

All images in one trusted inbound collection are forwarded once. Duplicate photo-draft calls share one result and use a key derived from trusted message identity, even if the model changes its key. Explicit estimate-only/no-save text still blocks every meal/preset mutation, including direct factory calls.

## Diagnostics

Lines beginning `[clawfit-media]` contain fixed reason codes, counts and booleans only. They never contain phone numbers, JIDs, session/message/call IDs, grants, paths, image data, captions, raw errors or credentials.

| Code | Meaning |
| --- | --- |
| `turn_captured` | Trusted WhatsApp message identity and media metadata captured |
| `missing_inbound_identity` | A required trusted identity field was absent |
| `run_bound` / `run_unbound` | Unique prompt/run correlation succeeded or failed |
| `call_bound` / `call_unbound` | Host tool-call association succeeded or failed |
| `missing_call_receipt` | Factory received no matching host-issued grant |
| `identity_mismatch` | Required factory identity was absent or disagreed |
| `closed_turn` | Receipt belongs to a completed turn |
| `media_resolved` | Original bytes passed file validation; `imageCount` records the count |
| Resolver error codes | `image_not_found`, `symlink_escape`, `path_traversal`, `invalid_image_content`, `oversized_image`, `too_many_images`, `unauthorized_media` |

`attachmentCount`, `bound`, `hasTrustedMetadata`, `hasInboundAccount`, `activeRegistration` and stage-specific presence/file-access booleans distinguish metadata loss from security/file failures without revealing identities.

## Regression coverage and limits

`scripts/whatsapp-runtime.integration.test.ts` builds current plugin source and starts an isolated child process. It executes the pinned host loader twice, the real SDK media store, inbound builder/finalizer, agent-context builders, hook runner and tool wrapper. Its factory contexts contain neither attachments nor run IDs; dispatch has no run ID. Active and discovery factories share one exact-byte, two-image request. The real lifecycle callback revokes the grant. No-save is checked through both the hook and direct execution.

`scripts/whatsapp-media.integration.test.ts` uses the SDK builder/finalizer and separate hook/factory APIs, plus the authenticated Fastify Health API and real nutrition estimator with a fake model. It covers exact bytes, missing accounts, named-account rejection, sender/group/session isolation, ordering and ambiguity, missing call IDs, IDs reused across runs, stale/ended grants, unavailable files, private diagnostics, multi-image deduplication, one photo draft and failed-estimate write suppression. Existing resolver/security/API tests remain in the suite.

**Collection boundary:** the two-image test covers two media facts in one host-finalized inbound context. It does not treat neighboring WhatsApp messages as an album. The inspected `@openclaw/whatsapp@2026.7.1` package uses the same SDK builder and bypasses debounce for photo messages; its installed CIA version was not supplied. Separate delivered messages remain isolated. Automatic multi-message album grouping requires an explicit trusted collection contract from the channel; inferring membership from time, sender or history would violate the isolation requirement.

No live WhatsApp send, Gemini call, CIA connection, database change or historical reconstruction is part of these tests. The final acceptance check remains the user's real WhatsApp photo forwarded to Render.

## Deployment and acceptance

After reviewing and merging the PR, deploy the approved merge commit through the existing script:

```bash
sudo bash /home/clawfit/app/deploy/openclaw/redeploy.sh <approved-commit-sha>
```

Send one fresh food photo with: “Estimate the calories, protein, carbs and fat. Do not save anything, including pending drafts.” Match its MYT time to `[clawfit-media]` records and Render's `/v1/nutrition/estimate` record with `imageCount: 1`; no pending/confirmed write should occur. A host-delivered two-image collection should produce one estimator request with `imageCount: 2`. Separate messages should each have only their own attachment.

If rejection remains, the reason codes identify the failing stage. Inspect those codes and the installed WhatsApp plugin version before changing anything else. Pairing, credentials, sender mappings, database/history, migrations, network configuration and nutrition models are outside this change. No deployment-script modification or database migration is needed.
