# Diagnose a stopped upgrade at API readiness

The October 13 CIA upgrade twice stopped at the authenticated Health API readiness
gate. A separate request returned HTTP 200 with ready/configured/database/schema
flags true. Render confirmed the PR #11 merge was live from 11:39 AM MYT and
recorded the successful `/ready` request at 1:19 PM. No `/ready` arrival was
recorded around the second reported upgrade failure, and no service failure or
restart event was returned in that period. These observations do not establish
the cause of the failed request. Do not assume a cold start, bad credential,
wrong model or database problem without the diagnostic reason.

The gate checks configuration and authenticated `/ready`; it never calls Gemini.
`estimator: configured` means the API constructed an estimator. It does not prove
that the configured nutrition model will successfully generate an estimate.

## Confirmed DNS failure and bounded recovery

At 2026-10-13 08:19 UTC (4:19 PM MYT), CIA's original full preflight passed all
seven earlier checks, accepted its URL/token/origin and reported `dns_failure`
after 10,044 ms. It never obtained an HTTP response. The effective API values
matched the protected environment; neither value was inherited from the shell.
This identifies name resolution as the failing stage. The old observer grouped
`EAI_AGAIN` and `ENOTFOUND`; it does not establish which code occurred, why that
lookup failed, or why earlier isolated requests succeeded. No host DNS, Tailscale,
firewall, provider key/model or database changes are justified by this output.

The repository gate now permits at most three GET `/ready` attempts **only** when
the transport reports temporary DNS failure `EAI_AGAIN`. The waits are 250 and
500 ms and share the original 50-second signal with all requests/body reads.
`ENOTFOUND`, TLS, connection, cancellation, HTTP/authentication, redirect, JSON
and estimator failures are not retried. Every attempt must pass the existing
authenticated readiness contract. Exhaustion still fails and stops deployment.
This handles temporary lookup failures; it cannot repair a persistently broken
host resolver and is not evidence that CIA has recovered.

To verify on CIA's old stopped checkout before deployment, supply
`--verify-dns-retry` to the archived runner instead of `--observe-preflight`.
This explicitly overlays the same reviewed retry helper on the original full
preflight's readiness fetch, preserving its authorization, URL, redirect
rejection, response parsing and exit status. It emits retry counts and the
allowlisted DNS code. It leaves the checkout/configuration and stopped gateway
in place. The observer detects an already installed repository retry and avoids
a second retry layer. Plain `--observe-preflight` remains observation only.

Retry code is restricted to readiness; nutrition estimation, pending/confirmed
meal operations and all existing plugin non-retryable failures are unchanged.

## Collect evidence before another upgrade

Both isolated probes subsequently passed on CIA, but the original full preflight
still failed. Those probes use a refactored gate and `pnpm exec tsx`; they do not
establish what failed in the original package script after its preceding checks.
Do not repeat the isolated probe or redeployment to explain that discrepancy.

Supply `--observe-preflight` after the reviewed SHA to the archived-source runner
to observe **the current, unchanged** `pnpm openclaw:preflight --before-restart`.
It installs a temporary Node preload only for that child invocation. The preload
matches the preflight entry point; OpenClaw subprocesses and other CLI processes
remain unaffected. The original fetch arguments, redirect rejection, response,
JSON parsing, schema validation, exception and exit status are preserved. It
makes no extra request and does not start the gateway. The ordinary directory
ownership/write-access check still runs, as in the existing preflight.

The observer records attachment, input-validation booleans, effective environment
equality, request start, safe transport reason, HTTP status and readiness-contract
booleans. A missing observer is reported explicitly rather than being treated as
a successful diagnostic. No request indicates a pre-request validation failure
or earlier termination; HTTP and contract reports identify how far the original
request progressed. Tests exercise the exact deployed `5555336` gate, the pnpm
package script/tsx child, denied HTTP, rejected redirects, bad JSON, unconfigured
estimator and validation failure. No production credentials or provider calls
are used in these tests.

The archived-source runner can collect evidence on the existing stopped CIA
installation before any new deployment. Fetch the reviewed diagnostic commit,
then stream `scripts/run-readiness-diagnostics.mjs` from that immutable commit to
`node --input-type=module -`, supplying the same full commit SHA as its argument.
Run this as `clawfit` from `/home/clawfit/app`. It reads the two diagnostic source
files into a temporary directory, reuses the current checkout's environment
loader and installed dependencies, and removes the temporary directory afterward.
It compares `pnpm exec tsx` with direct Node. It never checks out a commit, starts
a gateway, updates configuration or displays child launch-error stacks/paths.
Tests verify that both the checkout SHA and its working-tree status are unchanged.

After this diagnostics change is approved and available in the CIA checkout,
run only the readiness diagnostic as the existing service user:

```bash
sudo -u clawfit -H bash -c 'cd /home/clawfit/app && pnpm openclaw:diagnose-api'
sudo -u clawfit -H bash -c 'cd /home/clawfit/app && node --import tsx scripts/health-readiness-diagnose.ts'
```

Both commands execute the same gate. Compare runtime, inherited/protected/repo
environment equality flags, reason, HTTP status and elapsed milliseconds. Output
contains no variable values, hashes, URLs, actual file paths, message contents or
credentials. Unknown Error messages, stacks, response bodies and redirect
locations are never printed. An unreadable environment source is reported only
as a boolean. The diagnostic does not modify any environment file, identity,
configuration or database record.

The ordinary preflight prints the same structured HTTP/readiness result before
its PASS/FAIL line, including request-attempt count and a whitelisted DNS code on
DNS failure. Its total 50-second limit, success requirements, failure exit and
deployment stop remain. Redirects are still rejected; the diagnostic observes
their status without forwarding the bearer token to another origin.

| Reason | What the evidence establishes |
| --- | --- |
| `missing_api_url`, `invalid_api_url`, `unsafe_api_origin`, `invalid_api_token` | Configuration validation failed before any API request. |
| `request_timeout` | The request or response body exceeded the allowed wait. |
| `dns_failure`, `connection_refused`, `connection_reset`, `tls_failure` | A known transport error prevented a usable response. |
| `request_failed` | Transport failed with an unrecognized safe error classification. |
| `redirect_response` | The API endpoint redirected; credentials were not forwarded. |
| `http_unauthorized`, `http_forbidden` | The reached endpoint rejected authentication or access. |
| `http_unavailable`, `http_error` | The endpoint returned a failing HTTP status. Error bodies are not logged. |
| `invalid_json`, `invalid_readiness_response` | The response did not satisfy the existing readiness contract. |
| `api_not_ready`, `estimator_unconfigured` | The parsed response explicitly reported a readiness/configuration problem. |
| `ready` | This particular authenticated readiness request passed. |

When the reason is `ready` in the deployment runtime, retry the approved
repository redeployment command. Do not bypass the gate by manually starting
the stopped gateway. Verify real photo forwarding only after the upgrade passes.
If this check fails again, retain timestamps and its fixed structured reason so
Render observations can be matched to that attempt.

No provider model, key, quota, pairing, identity mapping, database migration,
historical meal, firewall or Tailscale configuration is changed by this patch.
