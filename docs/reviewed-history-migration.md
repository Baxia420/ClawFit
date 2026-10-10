# Reviewed WhatsApp history migration

The importer takes the final reviewed JSON directly. It does not reconstruct meals, analyze images or call Gemini. Run it from the repository root on a durable Linux runner with Node 24 and the locked pnpm dependencies installed.

## Data and ownership mapping

Each active source consumption event becomes one `meals` row for each participant present in its `nutrition_by_person`. Shared events retain the same `sharedEventId` in each person's audit metadata. The importer filters `meal_items` to the participant's consumed allocation. Full served/consumed quantities, components, human corrections, original export snapshots and subsequent decisions are retained in `meals.raw_user_text` as a structured `historicalImport` envelope. Display labels and portions respect existing column lengths; full text remains in the audit envelope.

`Mahin` resolves to `Jobayer`. Every unknown participant or duplicate allocation fails validation. UUIDs are resolved explicitly against each person's existing WhatsApp external identity and active user; primary/partner bootstrap IDs are never assumed to establish ownership. Both users must belong to the existing household. Settings with a different timezone fail preflight and are not changed automatically.

Eating dates/times use `Asia/Kuala_Lumpur` / UTC+8. Dates with no known eating time use local noon solely as a database date anchor, retain `actualMealTime: null` and display “Time unknown.” Chat log timestamps remain in the source evidence, including prior-day corrections. Source calorie values/ranges round to integers for the existing integer columns; exact source values remain in audit metadata. Macros use PostgreSQL `real` and reconcile within 0.001g.

Unknown calories/macros remain SQL NULL. Migration `0006_historical_nutrition_unknowns.sql` removes NOT NULL from six meal nutrition columns without changing existing values. Draft/preset input validation continues to require ordinary numeric estimates. Historical incomplete daily sums and trend averages remain unknown; the dashboard does not show invented zeros or target progress based on missing protein. Known zero values remain zero.

## Private inputs

Keep the reviewed JSON, identity manifest, receipts and recovery backup outside tracked files; `historical-private/` is ignored. The identity manifest has exactly two keys, `Jobayer` and `Cici`, each containing `userId` and `externalIdentifier`. Populate them from the actual users and their already-linked WhatsApp identities, not from display names alone. Do not commit this manifest or the meal export to this public application repository.

Configure `DATABASE_URL` privately in the runner environment or the existing root `.env`. Do not paste it into a pull request. This tool does not start the API or run schema migrations automatically.

An operator can inspect current identities using this read-only query in the authorized database session:

```sql
BEGIN READ ONLY;
SELECT u.id, u.display_name, u.role, u.active,
       e.provider, e.external_identifier,
       h.household_id, s.timezone
FROM users u
LEFT JOIN external_identities e ON e.user_id = u.id
LEFT JOIN household_members h ON h.user_id = u.id
LEFT JOIN user_settings s ON s.user_id = u.id
ORDER BY u.id, e.provider, e.external_identifier;
COMMIT;
```

The query is intended for the operator's private database session. The dry-run report records identity fingerprints rather than phone numbers.

## Read-only live preflight

The default command performs only reads in a serializable read-only transaction. It accepts the existing non-null schema, reports whether the known nullable upgrade is needed, verifies identity evidence, checks stable-ID collisions and inventories existing meals by owner/date. It hashes all target meals/items/drafts and protected users/settings/identities/presets/workout records. The concrete plan includes counts, overlapping dates, dates outside the imported history and an approval digest.

```bash
pnpm history:import \
  --data historical-private/reviewed.json \
  --identities historical-private/identities.json \
  --out historical-private/live-dry-run.json
```

Local schema simulation is available without a production connection. It applies repository migrations only in PGlite, imports the real reviewed payload, retries, rolls back, reimports and reports daily totals. Its simulated identities are test fixtures and do not verify production ownership.

```bash
pnpm history:import --simulate \
  --data historical-private/reviewed.json \
  --out historical-private/local-simulation.json
```

## Production approval and execution

Obtain explicit authorization for the live receipt before production writes. The scope is the application/nullable-schema upgrade plus replacing **all existing meals, their items and pending meal drafts for precisely the two verified users**, including old meals outside the history date window. Retain users, settings, notification preferences, identities, households, food presets, workouts, exercises, sets and other users' meals. This implements the requested meal-only reset; it is not a database-wide wipe.

After authorization, deploy this application's compatible unknown-nutrition handling and its nullable schema migration. Review the live receipt's old meal/draft counts and date inventory. The importer permits the one predicted nullable upgrade between preflight and execution; other changes to data, identity, settings or inventory invalidate approval. It will not execute while the old non-null columns remain.

Set `CLAWFIT_APPROVED_PLAN_DIGEST` to the exact authorized digest from `live-dry-run.json`, then run:

```bash
pnpm history:import --execute \
  --data historical-private/reviewed.json \
  --identities historical-private/identities.json \
  --plan historical-private/live-dry-run.json \
  --approve-plan "$CLAWFIT_APPROVED_PLAN_DIGEST" \
  --backup historical-private/pre-import-backup.json \
  --out historical-private/execution-result.json
```

The backup path must not already exist. The importer uses one serializable transaction and locks the meal/item/draft tables against concurrent writes. It re-verifies the approved inventory, deletes only the two users' meal drafts and meals, inserts stable UUIDs/idempotency keys and items, reconciles every field/item, checks protected records, then writes and fsyncs the private backup before commit. A backup-write or reconciliation failure rolls back the entire replacement.

The idempotency key is `clawfit-whatsapp-history-v1:<sourceMealId>:<person>`. UUIDs and item IDs derive from the same fixed namespace, independently of source file revisions. A retry of the same already-imported payload verifies its content and returns `already_imported` without deleting anything or inserting copies. A changed source or inventory requires a new plan and authorization.

## Recovery and reconciliation

Before commit, ordinary PostgreSQL transaction rollback is the recovery mechanism. After commit, the backup contains the exact previous meals, items and drafts and a fingerprint of the committed replacement. Explicitly authorize recovery and run:

```bash
pnpm history:import --rollback \
  --backup historical-private/pre-import-backup.json \
  --approve-plan "$CLAWFIT_APPROVED_PLAN_DIGEST" \
  --out historical-private/recovery-result.json
```

Recovery verifies backup integrity and refuses to overwrite meals edited or added since import. It restores parent meals before their items and drafts, reconciles the full snapshot and does not reset user settings. The nullable schema stays in place; restoring NOT NULL would be unsafe while unknown rows exist.

Run [historical reconciliation queries](../scripts/validate-reviewed-history.sql) in a read-only psql session, supplying the verified `jobayer_user_id` and `cici_user_id` variables. Compare person counts, food counts, date totals, null counts and shared-event links with the private dry-run payload. Confirm historical dates and unknown values in each user's Nutrition and Together screens. Code tests and local simulation do not substitute for this live verification.

If an execution command loses its connection after attempting commit, do not infer success from the CLI exit status or wipe again. Run the read-only preflight: an exact imported state reports `alreadyImported`; a differing state requires inspection. The backup and stable keys support recovery without duplicate insertion.
