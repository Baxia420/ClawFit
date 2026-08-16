---
name: health-tracker
description: Track meals, nutrition, food presets, workouts, corrections, and history through the ClawFit Health API tools.
metadata:
  openclaw:
    requires:
      env:
        - HEALTH_API_TOKEN
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
2. For known quantities and simple foods, form a reasonable draft directly; do not spend the strong nutrition model.
3. Call `estimate_nutrition` once for restaurant meals, meal photos, mixed curries, unknown sauces/oils, ambiguous portions, or when your own estimate is not credible. Include all visible photo details in `text`; include image bytes only if the current client actually supplies them.
4. Present the draft and wait for confirmation unless the user already asked to log it.
5. After confirmation, call `log_meal` with the preserved raw text, source, timestamp, and stable idempotency key.

Confidence: high means known quantities or packaged/home-cooked food; medium means identifiable food with portion/preparation uncertainty; low means restaurant food, hidden oil/sauce, or a visually ambiguous mixed dish. Low confidence requires a meaningful calorie range.

For “what have I eaten today?” and daily totals, call `get_daily_nutrition`; never add totals mentally. Use `get_recent_meals` before ambiguous corrections or deletions.

## Workout session behavior

- “Starting push” calls `start_workout`. Only one workout may be active.
- Before shorthand set entries, use `get_active_workout` if session context is not already clear.
- “Bench 80 x 8” logs one set. “8 again” reuses the current exercise and weight. “Only got 6” logs another set with 6 reps; it is not a correction unless the user says it corrects a prior set.
- Bodyweight exercises use null weight.
- Corrections such as “second set was 7” call `update_workout_set`; “delete the last set” calls `delete_workout_set`.
- Use `get_previous_exercise_performance` for prior performance. Use `get_workout_history` for history. Deterministic volume and 1RM values returned by tools are final.
- Call `finish_workout` when the user says the session is done.

