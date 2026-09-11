---
name: health-tracker
description: Track meals, nutrition, food presets, workouts, corrections, and history through the ClawFit Health API tools.
metadata:
  openclaw:
    requires:
      env:
        - HEALTH_API_OPENCLAW_TOKEN
---

# ClawFit health tracker

Apply this skill when the user describes food, asks about nutrition, starts or logs a workout, corrects health records, or asks about history.

## Non-negotiable rules

- The Health API/database is authoritative. Never claim a write succeeded unless the tool succeeded.
- An estimate is a draft, not a logged meal. Show the best estimate, range, confidence, and important uncertainty; call `log_meal` only after explicit confirmation such as “log it”, “save it”, “track it”, “yes”, or a corrected amount plus a request to log. If the original message explicitly says to log, that is confirmation.
- Give each create call a stable idempotency key for the user action. Reuse it on retries.
- Resolve natural corrections to IDs with recent/active-state tools, then update or delete the existing record. Do not create replacement records.
- Nutrition values are estimates, not diagnosis or treatment. Preserve uncertainty and avoid false precision.

## Meal routing

1. Call `find_food_preset` first for “usual”, “normal”, or named repeated foods.
2. For food descriptions and photos needing nutrition estimation, call `estimate_nutrition` once to route through the dedicated strong model. Include all visible details from photos, packages, or descriptions. If both a product package and nutrition label are provided, inspect both and prioritize printed nutrition label values. Never calculate or invent calories/macros mentally.
3. Persist every unconfirmed draft with `create_pending_meal`, then present it and wait for confirmation. The tool derives the peer/session scope; do not invent or pass a scope yourself.
4. To correct an unconfirmed draft before confirmation, call `update_pending_meal`. Never call `update_meal` for unconfirmed drafts.
5. On user confirmation (“log it”, “log both”, “yes”, “save it”), call `confirm_pending_meal` directly. Do NOT re-run `estimate_nutrition`. For a single meal, “log it” confirms the pending draft; for multiple meals, “log both” confirms the active drafts.
6. Once confirmed, subsequent corrections to the logged meal must use `update_meal` with the canonical `confirmedMealId` returned by `confirm_pending_meal`.
7. For date corrections (“that was yesterday”, “move meals to yesterday”, “I ate this last night”), use yesterday's local calendar date in Asia/Kuala_Lumpur and update `occurredAt` via `update_meal` (or pass `occurredAt` to `confirm_pending_meal`).

Confidence: high means known quantities or packaged/home-cooked food; medium means identifiable food with portion/preparation uncertainty; low means restaurant food, hidden oil/sauce, or a visually ambiguous mixed dish. Low confidence requires a meaningful calorie range.

For “what have I eaten today?” and daily totals, call `get_daily_nutrition` with today's local date in Asia/Kuala_Lumpur; never add totals mentally. Use `get_recent_meals` before ambiguous corrections or deletions.

## Workout session behavior

- “Starting push” calls `start_workout`. Only one workout may be active.
- Before shorthand set entries, use `get_active_workout` if session context is not already clear or across fresh session boundaries.
- “Bench 80 x 8” logs one set. “8 again” reuses the current exercise and weight from `get_active_workout`. “Only got 6” logs another set with 6 reps; it is not a correction unless the user says it corrects a prior set.
- Bodyweight exercises use null weight.
- Corrections such as “second set was 7” call `update_workout_set`; “delete the last set” calls `delete_workout_set`.
- Use `get_previous_exercise_performance` for prior performance. Use `get_workout_history` for history. Deterministic volume and 1RM values returned by tools are final.
- Call `finish_workout` when the user says the session is done.
