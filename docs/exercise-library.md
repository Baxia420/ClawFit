# Exercise Library

The library lives at `/workouts/library`, with shareable detail URLs under
`/workouts/library/<stable-id>`. The Train and Plans editors use the same picker.
It supports name/curated-alias/primary-and-secondary-muscle search, primary-group
and equipment filters, pagination, personal favorites, custom exercises, and
add/replace operations on existing routines. Replacement retains sets, reps and
rest. Instructions can be opened from an active workout without leaving its form.
The existing `/exercises/[name]` history route remains available.

The browser uses compact text rows: name, primary muscle, equipment, favorite,
and Add to plan (or Select in a routine picker). There are no image tiles or
blank preview panels. Mobile filters open from the Filters button, which shows
the active-filter count. Exercise details start with instructions; available
licensed illustrations and user-linked videos are in an optional Demonstration
section. The Add to plan row action opens details focused on the routine selector.

## Catalogue and media

- 1,324 exercise records, all with English step-by-step instructions.
- 19 exercises have 38 locally hosted still illustrations (4.53 MB total).
- No bundled animations or videos. Entries without demonstrations show instructions
  without an empty media section.
- Custom exercises can reference an HTTPS YouTube watch link; the privacy-enhanced
  embed loads only after the user selects Load. No backend URL fetching or uploads.
- Unknown difficulty is left null. Difficulty filters appear when a user's custom
  exercises specify it. Imported type is only `cardio` for the source's cardio
  category and `stretching` when explicitly named a stretch; all other types remain
  unspecified rather than inventing metadata. Custom exercises support type/level.
- Primary target mapping preserves unsupported targets as Unclassified for existing
  training statistics; precise primary/secondary text remains visible/searchable.
  Training volume attribution remains single-primary-group, not a new metric.

The JSON catalogue is bundled **only in the Health API's repository package**.
The browser receives a page at a time. PostgreSQL holds personal custom definitions
and favorites, not 1,324 duplicated exercise records for every user. Search uses a
precomputed in-process text index; it makes no external service calls. Images are
lazy loaded and served by the web application. The catalogue is about 1 MB of text.

## Licensing and provenance

See [the source ledger](exercise-sources.md), the complete MIT notice in
`docs/licenses/exercises-dataset-MIT.txt`, and the per-asset source, author, license,
size and SHA-256 manifest in `docs/licenses/exercise-media.json`. Attribution is
also shown next to illustrations and instructions in the app. Do not replace the
current media allowlist with bulk upstream media imports.

## Data boundaries and migration

`0008_tranquil_shatterstar.sql` adds `custom_exercises`, `exercise_favorites`, and
nullable `exercises.library_id`. It does not update, delete or backfill any workout,
meal, set, routine, or user row. The generated Drizzle snapshot/journal are included.
Routine JSON and immutable workout snapshots accept an optional `libraryId`.
Stable catalogue IDs are `edb:<upstream-id>`; custom IDs are `custom:<uuid>`.
Do not regenerate or recycle IDs when names change.

Every endpoint is behind existing Health API authentication. The web adapter uses
server-signed assertions; caller-supplied user IDs never select an owner. Custom
IDs are checked against the authenticated owner when saving routines/sets or
favorites. The shared catalogue is read-only. Custom writes use optimistic
versions; creates use per-user idempotency keys. Favorite PUTs are idempotent.
Neither user sees the other's custom definitions, favorites, routines or history.

History joins linked records by stable ID, even after a custom rename. Only exact,
unambiguous catalogue names/curated aliases include legacy records with null IDs.
No fuzzy merge rewrites history. Existing free-text history URLs remain authoritative
for spellings not recognized by the catalogue. A same-name conflict inside an
active workout is refused rather than silently changing its exercise identity.

Deploy sequence: take the normal database recovery checkpoint, run migration
explicitly, deploy the Health API, then deploy the web application. Readiness checks
require the new tables/column. A frontend rollback does not require dropping the
additive tables or removing IDs. No migration has been run against production by
this implementation. OpenClaw configuration, pairing and deployment are untouched.

## Future Android app (not implemented)

Capacitor is a reasonable container for the existing mobile web experience, but
Next.js server rendering and authentication still need a deployed web/API backend
(or a separately built mobile client). A WebView wrapper alone does not provide
native home-screen widgets. Those require Android AppWidgetProvider/Glance code,
small authenticated API summaries, and native background refresh/caching policies.
Keep tokens in platform-secure storage and distinguish stale widget data from live
values. The authenticated Health API and stable exercise IDs are reusable for that
future client. No Capacitor dependency or Android project is added here.

## Verification and maintenance

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and
`pnpm openclaw:plugin:validate`. Browser acceptance uses real Next.js and Fastify,
an ephemeral PGlite database and synthetic local session keys only:

```
pnpm exec playwright install chromium
pnpm build
pnpm test:library:browser
```

Set `CLAWFIT_SCREENSHOT_DIR` to retain desktop/mobile screenshots. The test covers
search, favorites, separate users, custom create/edit, target-preserving routine
replacement, the routine picker, and instructions during an active session.
It never reads DATABASE_URL or connects to the deployed Health API.

To reproduce the text import, obtain only the reviewed upstream JSON snapshot and
run `node scripts/import-exercise-text.mjs /path/to/exercises.json`. The importer
checks its SHA-256, strips all upstream media fields, and reuses only the reviewed
local media manifest. Updating the source hash or adding media requires reviewing
licensing, stable IDs and semantic exercise mappings again.
