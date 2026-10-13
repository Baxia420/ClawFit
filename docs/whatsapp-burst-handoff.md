# WhatsApp burst delivery on OpenClaw 2026.7.1-2

PR #10 was followed by a production failure involving simultaneous captures.
See [Household meals and photo collections](household-meals-and-photo-collections.md)
for the compile-cache respawn correction, updated collection behavior and
reciprocal household logging. The sections below record the earlier investigation.

## Evidence and scope

The October 12 post-PR-9 log contains a successful single-photo API estimate.
For each subsequent pair, WhatsApp received two separate image messages but
sent only one visible reply. The second estimate tool invocation had no matching
success-only Health API latency line. That absence does **not** establish whether
it failed before HTTP, received an HTTP error, or failed for another reason.
The later `No callable tools remain` error is also not explained by those logs.
No production database or gateway changes were made during this investigation.

The repository replay reproduces two concrete defects with the pinned SDK:

1. The full dispatcher can replace the active plugin registry between
   `reply_dispatch` and `before_prompt_build`. PR #9 shared call receipts across
   discovery factories, but kept captured turns in the original API instance.
   A replacement hook had zero candidates even though the initial hook captured
   a trusted attachment. Bounded turn/run state now survives that registration
   change. Full identity checks, unique-candidate binding, expiry, closed turns,
   and unpredictable per-call grants still apply.
2. `dispatchInboundMessageWithBufferedDispatcher` starts a foreground reply fence
   before `reply_dispatch`. Its key includes channel, account, session, chat type
   and target, but not message ID. A newer overlapping dispatch can cancel an
   older final reply before the plugin's `reply_payload_sending` hook runs.
   The unmodified full-runtime replay forwards two distinct originals in two
   successful HTTP requests but delivers only one reply. Changing the WhatsApp
   queue mode to `followup` did not prevent this result.

Inspected sources: pinned core `dist/dispatch-DnzGTpPs.js`,
`get-reply-OTG64ybi.js`, `hook-agent-context-DPPRzCBU.js`, and tool wrapper/loader;
published `@openclaw/whatsapp@2026.7.1` `dist/monitor-DD8bXohk.js`. The WhatsApp
monitor bypasses text debounce for media and passes its finalized context to
the same buffered dispatcher. Its default reply resolver is `getReplyFromConfig`.
The exact installed WhatsApp extension version was not supplied in the logs.

These reproductions explain possible handoff and reply-loss mechanisms, not
every production failure. The new `[clawfit-api]` records distinguish success,
HTTP error, network error and invalid response, with status/duration and a fixed
operation category. `[clawfit-media]` retains binding/file-access reason codes.
Neither diagnostic includes identities, paths, captions, bytes or credentials.

## Repository-managed runtime compatibility

The service still runs the existing global OpenClaw installation. Its new Node
launcher installs a process-local module load hook; nothing edits `node_modules`
or the global installation. The hook checks the exact version and SHA-256 of the
pinned dispatch bundle before applying a narrow transformation. An unknown
version or changed bundle is rejected for review.

For WhatsApp routes with `clawfit-health` explicitly enabled, admission is
serialized **before** the host foreground fence, through completed delivery.
Each message retains its own original context. Different routes remain
independent. Failed dispatches release admission for the next message. Other
channels and installations without the health plugin retain stock behavior.
This queues later requests, including text follow-ups, behind the current turn;
they no longer interrupt that turn. It does not remove provider rate limits.
Queued messages are in memory and are not durable across a gateway restart.

Separate WhatsApp messages receive separate estimates/replies. They are not
automatically treated as one meal. When the channel supplies a single trusted
collection, both originals reach one estimator request; repeated tool calls
reuse that turn's estimate/draft. Existing no-save and confirmation rules apply.

## Regression coverage

`scripts/fixtures/whatsapp-burst-replay.mjs` executes the actual SDK inbound
builder, media store, buffered dispatcher, plugin loader, prompt/tool hooks,
tool factory and delivery path. The host generates run IDs. Tests never add
paths or run IDs to a factory context. Model responses come from an in-memory
provider, API responses from a fake transport, and socket connections are
blocked. Only synthetic images and temporary state are used.

Scenarios cover stock-host reply suppression, successful burst and simultaneous
arrival delivery, a 503 estimate followed by another photo, and a two-image
collection with duplicate estimator calls. A deliberately guessed response after
the 503 must become a safe error. Additional integration tests cover active
registry replacement, optional accounts, unauthorized/cross-sender/stale media,
path/symlink/size defenses, exact bytes, deduplication and explicit no-save writes.
Compatibility checks reject unknown runtime versions and bundle modifications.

## Deployment and acceptance

Merge only after the repository CI checks pass. Then use the approved process:

```bash
sudo bash /home/clawfit/app/deploy/openclaw/redeploy.sh <approved-commit-sha>
```

The new `repair-state.sh` refreshes the repository-owned systemd unit because
the old redeploy script already calls it after checkout. This makes the first
upgrade activate the launcher without another manual command. The new redeploy
script also refreshes the target unit, allowing rollback to the old launcher.
Systemd drop-ins are not edited. Pairing, credentials, identity mappings,
historical meals, migrations, firewall settings and model selections are not
changed by this fix. Normal preflight checks still apply.

After deployment:

1. Send one photo with **“Estimate only. Do not save or log anything.”** Confirm
   a successful `[clawfit-api]` `nutrition_estimate` outcome and the corresponding
   Render `/v1/nutrition/estimate` request, with no meal writes.
2. Send two different photos rapidly, each with the same no-save caption. Expect
   two estimates/replies and two estimator requests, each tied to its own photo.
   Separate messages are not a collection, even when uploaded together in the UI.
3. Verify no `/v1/meals/pending` or confirmed-meal write occurred for those tests.
   Keep the test timestamps so sanitized gateway and Render evidence can be
   compared if a reply is missing. Do not paste credentials or raw media paths.

If rollback is needed, use the same approved redeployment process with the prior
approved SHA. Keep the existing encrypted recovery snapshot; do not reset or
re-pair WhatsApp.

## Additional Gemini keys

Google applies rate limits per project, not per API key:
<https://ai.google.dev/gemini-api/docs/rate-limits>. Multiple keys from the same
project do not add token/request quota. The supplied quota screenshot shows
token-limit pressure, not proof that a key expired or that quota caused every
missing reply. No keys were added, rotated, logged or committed. Backup-key
configuration needs the keys' project association and secure installation;
it should not be conflated with the photo-dispatch correction.
