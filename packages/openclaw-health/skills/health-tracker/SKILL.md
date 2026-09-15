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
- ABSOLUTE PROHIBITION ON SELF-ESTIMATION: If `estimate_nutrition` fails or returns an error, the assistant is strictly forbidden from attempting to calculate, guess, or estimate calories/macros itself, and must NEVER call `create_pending_meal` or `log_meal` with self-calculated or hallucinated numbers. It must report the failure directly to the user ("Nutrition service could not analyze this meal. Please try again later or enter details manually.").
- IDENTITY DELEGATION RULE: When a message specifies that a meal, photo, or query is for the sender's partner (e.g., "Cici had this", "log for Cici", "Cici ate 4 eggs", "what did she eat?"), you MUST explicitly populate `targetUserName: "Cici"` in the tool call (`estimate_nutrition`, `create_pending_meal`, `confirm_pending_meal`, `log_meal`, `get_daily_nutrition`, `get_recent_meals`, `update_meal`). When asked "what did she eat?", NEVER return meals belonging to the requester. Return only meals where targetUserName is Cici. Never assign a partner's meal to the message sender.
- THREE-TIER ESTIMATION TRANSPARENCY: When presenting an estimate where `isFallbackEstimate === true`, you MUST append a brief note: `"(Estimated via Flash Lite — 3.8 daily quota reached)"`. The WhatsApp conversational assistant itself must NEVER calculate nutrition values mentally in chat; always delegate estimation to `estimate_nutrition`.
- An estimate is a draft, not a logged meal. Show the best estimate, range, confidence, and important uncertainty; call `log_meal` only after explicit confirmation such as “log it”, “save it”, “track it”, “yes”, or a corrected amount plus a request to log. If the original message explicitly says to log, that is confirmation.
- Give each create call a stable idempotency key for the user action. Reuse it on retries.
- Resolve natural corrections to IDs with recent/active-state tools, then update or delete the existing record. Do not create replacement records.
- Nutrition values are estimates, not diagnosis or treatment. Preserve uncertainty and avoid false precision.

## Meal routing

1. Call `find_food_preset` first for “usual”, “normal”, or named repeated foods.
2. For food descriptions and photos needing nutrition estimation, call `estimate_nutrition` once to route through the dedicated strong model. Whenever the inbound WhatsApp turn contains one or more attached food or packaging photos, the agent MUST resolve those images via the media resolver and pass them inside the `images` array parameter of `estimate_nutrition`. Never discard the image and rely solely on caption text when visual data is present. If both a product package and nutrition label are provided, inspect both and prioritize printed nutrition label values. Never calculate or invent calories/macros mentally.
3. Persist every unconfirmed draft with `create_pending_meal`, then present it and wait for confirmation. The tool derives the peer/session scope; do not invent or pass a scope yourself.
4. To correct an unconfirmed draft before confirmation, call `update_pending_meal`. Never call `update_meal` for unconfirmed drafts.
5. On user confirmation (“log it”, “log both”, “yes”, “save it”), call `confirm_pending_meal` directly. Do NOT re-run `estimate_nutrition`. When `confirm_pending_meal` returns `status: confirmed` or `status: already_confirmed`, the meal is fully saved. Do NOT call `confirm_pending_meal` again. Do NOT call `log_meal`. Immediately respond to the user with a concise confirmation summary.
6. Once confirmed, subsequent corrections to the logged meal must use `update_meal` with the canonical `confirmedMealId` returned by `confirm_pending_meal`.
7. For date corrections (“that was yesterday”, “move meals to yesterday”, “I ate this last night”), use yesterday's local calendar date in Asia/Kuala_Lumpur and update `occurredAt` via `update_meal` (or pass `occurredAt` to `confirm_pending_meal`).

## UPDATING AN ALREADY LOGGED MEAL
When a user asks to modify, correct, or adjust an already logged meal (e.g. "update dinner", "she only had half the squid", "don't make a new entry"):
1. DO NOT call `create_pending_meal` or create a new meal draft.
2. Call `get_recent_meals(targetUserName: 'Cici', limit: 10)` (or requester's meals if for self) to find the existing confirmed meal record.
3. Match the meal by date/meal period (e.g. 'dinner') or food name ('squid' / 'sotong').
4. Call `update_meal(id: existingMealId, ...)` with the revised items, calories, and macros.
5. Inform the user that the existing meal was updated.

Confidence: high means known quantities or packaged/home-cooked food; medium means identifiable food with portion/preparation uncertainty; low means restaurant food, hidden oil/sauce, or a visually ambiguous mixed dish. Low confidence requires a meaningful calorie range.

For “what have I eaten today?” and daily totals, call `get_daily_nutrition` with today's local date in Asia/Kuala_Lumpur; never add totals mentally. If asking for partner ("what did she eat?"), pass `targetUserName: "Cici"`. Use `get_recent_meals` before ambiguous corrections or deletions.

## Workout session behavior

- “Starting push” calls `start_workout`. Only one workout may be active.
- Before shorthand set entries, use `get_active_workout` if session context is not already clear or across fresh session boundaries.
- “Bench 80 x 8” logs one set. “8 again” reuses the current exercise and weight from `get_active_workout`. “Only got 6” logs another set with 6 reps; it is not a correction unless the user says it corrects a prior set.
- Bodyweight exercises use null weight.
- Corrections such as “second set was 7” call `update_workout_set`; “delete the last set” calls `delete_workout_set`.
- Use `get_previous_exercise_performance` for prior performance. Use `get_workout_history` for history. Deterministic volume and 1RM values returned by tools are final.
- Call `finish_workout` when the user says the session is done.
