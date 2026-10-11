# Training hub

The workout page adds four views: Train, Plans, Stats and Body weight. This is an independent implementation inspired by OpenGym's workflows. No OpenGym code, exercise media or body-map geometry is included.

## Behavior

- Train: quick sessions, routine targets, manual set logging/corrections, previous-session hints and a rest timer. Manual and WhatsApp workouts use the same API and ownership model. Starting a routine copies its targets into the session; later routine edits do not change those targets.
- Plans: ordered exercises with primary muscle, target sets/reps and rest time; one routine per weekday. Archiving removes its future weekday assignments. Restoring retains the routine but does not recreate those assignments. Version checks prevent one device from overwriting another device's edits.
- Stats: completed sessions in the last 7, 30 or 90 local calendar days, ending on a selected date. Sessions belong to their start day in the user's stored timezone. Each set counts toward one primary muscle; compound secondary-muscle work and recovery are not modeled. External-load volume excludes unweighted bodyweight sets. Estimated 1RM uses sets of 1–12 reps. Exercise bests cover the selected window, not lifetime records. Unrecognized legacy exercise names remain unclassified.
- Body weight: one correctable weigh-in per local date, optional goal, chronological trend and a seven-calendar-day sample average. Missing days are not invented. Averages use the available weigh-ins inside the displayed window; early points can have fewer observations. Weight change compares the first and last recorded points in that window.

There is a small original exercise suggestion list; users can enter their own exercises. This version does not add an imported exercise library, coaching, secondary-muscle weighting, injury advice, recurring notifications or new bot tools. Empty sessions can be finished to leave the active session; they contribute a completed-session count but no sets or muscle activity.

## Migration and deployment

`0007_cooing_makkari.sql` adds four tables (`body_weights`, `training_profiles`, `workout_routines`, `workout_schedule`) and nullable `workouts.routine_snapshot` and `exercises.muscle_group`. It does not update or remove meals, users, settings or existing workout rows. Composite ownership foreign keys prevent assigning another user's routine, including direct database writes. The unique indexes must precede the schedule's composite foreign key; the SQL includes that ordering.

The migration is applied through the existing Drizzle journal with `pnpm db:migrate`. API startup does not run migrations. New API readiness requires the new schema. Run database migration first, deploy the Health API second, and deploy the web application third. Render currently needs an explicit deploy; a web-only deployment will leave the new views unavailable.

Before production execution, take a Neon recovery branch or a verified snapshot and confirm the target branch/database and migration journal. Dry-run migration 0007 against a database branch containing current schema and data. Reconcile counts for meals, meal_items, users, external_identities, user_settings, workouts, exercises and workout_sets before/after; all must match. Confirm readiness and inspect new tables, which initially contain no entries. Keep identity bindings and historical nutrition intact.

Verification after rollout: each user can create/edit a weigh-in, create a routine and assign weekdays, start it, log/edit a set, finish once, view muscle stats and inspect previous performance. Retrying a start or set must return the existing record. Schedule writes and weight writes replace their natural key. Confirm that the partner cannot access those routines, weights, sessions or assignments. No model requests are required for these checks.

## Recovery

Prefer rolling the API and web back to the previous release while leaving the additive schema intact. Earlier code tolerates these extra tables and nullable columns. This preserves newly logged training and weigh-ins and avoids schema journal divergence. Do not drop tables/columns or restore the entire database after users have recorded new data without exporting and reconciling that data first. If a migration fails, inspect the journal and transaction state before retrying; do not execute the SQL file repeatedly outside the migrator.

## Validation

Tests cover migration on existing workout data, readiness before/after migration, immutable routine snapshots, stale-version rejection, database/API ownership boundaries, dated weigh-in upserts, routine/start/set retries, completed-only stats, correction recalculation, local calendar boundaries, bodyweight volume, 1RM limits, real dates, seven-day sample windows and accessible empty states. Production builds and static/type checks run separately. Browser/device interaction validation remains part of deployment review; no live bot or Gemini calls are needed.
