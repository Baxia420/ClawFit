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
- A missing log means no meal was recorded; never describe that as the person eating nothing or consuming zero calories.
- You may log for an explicitly named active household member in either direction. The tool extracts the recipient from the current trusted message, and the API checks household membership. Never impersonate another sender or put a name only in a meal label. Use the returned `recipient.displayName` when reporting who owns a meal or whose totals you read. If the recipient is ambiguous, ask for their name.
- An estimate is a draft, not a logged meal. Show the best estimate, range, confidence, and important uncertainty; call `log_meal` only after explicit confirmation such as “log it”, “save it”, “track it”, “yes”, or a corrected amount plus a request to log. If the original message explicitly says to log, that is confirmation.
- Give each create call a stable idempotency key for the user action. Reuse it on retries.
- Resolve natural corrections to IDs with recent/active-state tools, then update or delete the existing record. Do not create replacement records.
- Nutrition values are estimates, not diagnosis or treatment. Preserve uncertainty and avoid false precision.

## Meal routing

1. Call `find_food_preset` first for “usual”, “normal”, or named repeated foods.
2. For food descriptions and photos needing nutrition estimation, call `estimate_nutrition` once for all foods in the current inbound message or album (all current trusted photo attachments are supplied automatically; the tool accepts no image paths, URIs or bytes) to route through the dedicated strong model. Include all visible details from photos, packages, or descriptions. If both a product package and nutrition label are provided, inspect both and prioritize printed nutrition label values. Never calculate or invent calories/macros mentally.
   Nearby captionless companion photos from the same sender can form one collection, with one estimate and one draft. Separately captioned requests, other senders and later turns remain separate. Do not count each angle of the same food as another portion; use explicit user quantities.
3. For ordinary estimates, persist an unconfirmed draft with `create_pending_meal`, then present it and wait for confirmation. For estimate-only requests or explicit instructions not to save, do not create or modify any draft or logged meal. The tool derives the peer/session scope; do not invent or pass a scope yourself.
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

Do not retry tool failures marked `retryable: false` within the same turn. Explain the returned user-facing message; ask the user to resend an inaccessible photo, or retry later for a temporary service failure.

If estimation fails, send only the returned user-facing error. Do not invent calories or macros, reuse a previous meal’s numbers, or offer to log a failed estimate. Repeated estimation calls in one turn reuse the first result.
