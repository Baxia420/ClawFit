# Household meals and WhatsApp photo collections

This follows PR #10 and addresses the new October 12 evidence. No production
records, identity mappings, credentials or model selections were changed during
implementation.

## What failed

The pasted log records two image messages arriving at 19:09:35 MYT. Both were
captured with one trusted attachment, then prompt binding reported
`run_unbound`, `candidateCount: 2`. Both estimate calls were blocked as unbound;
there was no nutrition API request in that turn. This is a correlation/admission
failure before the estimator. The final `client_loop` connection-reset line is
an SSH-client disconnect, not evidence of a gateway process crash. The later
22:51 meal screenshot is outside this log excerpt.

PR #10's runtime hook was installed only in the initial launcher process. The
repository systemd unit sets `NODE_COMPILE_CACHE`. The pinned OpenClaw
`openclaw.mjs` then respawns itself with a package-specific cache directory,
retaining `process.execArgv` but not JavaScript state. That launcher path does not
consult `OPENCLAW_NO_RESPAWN`. The previous `--version` regression exited before
cache setup and did not exercise it.

The launcher now carries a Node `--import` preload into the child. The preload
checks the exact pinned version/hash and installs the same process-local hook.
The real CLI regression runs a three-photo request after the actual cache
respawn, with no compatibility installation in the replay itself. It checks that
both processes installed the hook, the dispatcher was transformed, and all
originals reached one fake estimator request.

## Photo behavior

Admission reserves a route's place before any plugin capture or foreground reply
fence. Later requests wait through completed delivery, including failures.

Nearby captionless companion images from the same sender, account, session and
conversation form a collection. The window is 1.8 seconds after the latest
photo, bounded to 5 seconds overall. One common caption may arrive first or
later. This is a channel-owned collection window; it does not claim that the
pinned extension supplies an album ID.

- A collection receives one estimate, one reply, and at most one pending meal.
  Each companion receives the primary provider's explicit delivery outcome so
  its WhatsApp status completes without sending another reply. A queued payload
  alone is not treated as successful delivery.
- Original files are forwarded byte for byte. The four-photo, per-file and total
  request limits, traversal/symlink/ownership checks, and text-only model schema
  remain in force.
- A second nonempty caption starts a separate request. Other senders/accounts/
  routes and photos arriving after the window stay separate.
- Redelivery of a source message reuses its receipt. Different views of the same
  food must not become extra portions; the estimator prompt prioritizes stated
  quantities and explains multi-photo counting.
- An estimate-only caption blocks both pending and confirmed writes. Full
  runtime tests expose both write tools and deliberately try valid write calls,
  then verify zero write requests. A failed estimate cannot become guessed
  nutrition or a logging offer.

Diagnostics use only fixed reasons, version and counts:
`compatibility_ready`, `dispatcher_hook_applied`, and
`photo_collection_admitted`. No identities, captions, paths, image data or
credentials are included.

## Reciprocal household logging

An explicit current request such as “save this for Cici” or “log it for Mahin”
selects that recipient. The plugin extracts the name from trusted current text,
not model parameters, labels, quoted history or an invented sender identity.
“Cici had this; log it for her and not me” also selects Cici. Ambiguous pronouns
or requests for multiple people ask for a name instead of guessing a profile.

The API authenticates the original sender, checks the authorized conversation,
and resolves exactly one active member of the sender's household. Canonical
profile names and the existing Mahin/Jobayer and Cici/Athirah aliases are
supported. No identity records are rewritten. Unknown, inactive or out-of-
household recipients are refused. Web clients cannot use the routing header;
workout/settings/preset operations retain their existing ownership rules.

Delegated calls use dedicated `/v1/household/meals/...` and
`/v1/household/nutrition/...` URLs. An older API rejects them before a write,
instead of ignoring a new header and saving to the sender. Responses identify
the actual recipient; confirmation totals use that recipient as well.

A newly created delegated draft belongs to the beneficiary and retains its
creator's peer scope and recorder provenance. An ordinary later “yes” can find
that creator's draft without moving it to the sender's profile. Canonical
sender-scoped endpoints still reject another sender's scope.

An explicit named household request can also confirm the partner's existing
persisted draft. This has separate authorization through the household URL and
checks the draft's actual owner. The server loads its stored scope; the model
cannot supply another sender's attachment or alter draft ownership. The existing
expiry/cancellation checks and canonical idempotent confirmation remain. The
record captures who confirmed it. A plain “yes” by another sender does not
implicitly grant access to that partner's draft.

## Deploy and verify

After review/merge, let Render finish deploying the new Health API commit before
upgrading CIA through the approved redeployment script. No migration or data
import is needed. Existing records with wrong owners are not moved by deployment;
review those specific records before any correction.

Check the CIA service journal for `compatibility_ready` and
`dispatcher_hook_applied`. Then test:

1. Two or three photos uploaded together with one caption:
   “Estimate only. Do not save or log anything.” Expect one collection estimate
   and no pending/confirmed writes.
2. Two independently captioned photos with the same no-save instruction. Expect
   separate estimates with their own original images.
3. From each account, request a meal for the other person by name. Check the
   recipient reported by the tool and the corresponding dashboard; the sender's
   totals must not include the other person's meal.
4. Create an unconfirmed meal, then explicitly have the other member confirm it
   for its owner. Confirm one saved meal with the same persisted estimate.

Keep timestamps and sanitized gateway/Render evidence if a result differs. Do
not reset pairing, reconstruct history, change identity mappings or rotate model
keys as part of this deployment.
