import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { isFallbackNotice, isMealLogConfirmation, sanitizeUserFacingError } from "./confirmation.js";

const ConfigSchema = Type.Object({ apiUrl: Type.Optional(Type.String({ default: "http://127.0.0.1:4000" })) }, { additionalProperties: false });
const Id = Type.String({ format: "uuid" });
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 200 });
const NullableNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const Confidence = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);
const EstimateFields = {
  label: Type.String(),
  items: Type.Array(Type.Object({ name: Type.String(), portionDescription: Type.String() })),
  calories: Type.Object({ best: Type.Integer({ minimum: 0 }), low: Type.Integer({ minimum: 0 }), high: Type.Integer({ minimum: 0 }) }),
  macros: Type.Object({ proteinG: Type.Number({ minimum: 0 }), carbsG: Type.Number({ minimum: 0 }), fatG: Type.Number({ minimum: 0 }), fiberG: NullableNumber }),
  confidence: Confidence,
  uncertaintyReasons: Type.Array(Type.String()),
};
const LoggedMeal = Type.Object({
  ...EstimateFields,
  occurredAt: Type.String({ format: "date-time" }),
  source: Type.Union([Type.Literal("text"), Type.Literal("photo"), Type.Literal("preset"), Type.Literal("manual")]),
  rawUserText: Type.Union([Type.String(), Type.Null()]),
  idempotencyKey: IdempotencyKey,
});
const PresetMeal = Type.Object({
  ...EstimateFields,
  occurredAt: Type.String({ format: "date-time" }),
  source: Type.Literal("preset"),
  rawUserText: Type.Union([Type.String(), Type.Null()]),
  idempotencyKey: IdempotencyKey,
});

const plugin = defineToolPlugin({
  id: "clawfit-health",
  name: "ClawFit Health",
  description: "Authenticated domain tools for nutrition and workout tracking.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "estimate_nutrition",
      description: "Estimate a difficult or uncertain meal synchronously. This returns a draft only; it does not log anything.",
      parameters: Type.Object({
        text: Type.String({ description: "Meal description and all visual details available from an attached photo." }),
        imageBase64: Type.Optional(Type.String({ description: "Optional raw base64 image data when the active client can provide it." })),
        imageMimeType: Type.Optional(Type.String({ description: "MIME type paired with imageBase64." })),
      }),
      execute: (params, config) => healthFetch(config, "/v1/nutrition/estimate", { method: "POST", body: { text: params.text, ...(params.imageBase64 && params.imageMimeType ? { image: { base64: params.imageBase64, mimeType: params.imageMimeType } } : {}) } }),
    }),
    tool({
      name: "get_pending_meal",
      description: "Get the latest unconfirmed pending meal draft (or a specific draft by ID) across session boundaries.",
      parameters: Type.Object({ id: Type.Optional(Id) }),
      execute: (params, config) => (params.id ? healthFetch(config, `/v1/meals/pending/${params.id}`) : healthFetch(config, "/v1/meals/pending/latest")),
    }),
    tool({
      name: "confirm_pending_meal",
      description: "Confirm and persist an existing pending meal estimate by ID. Idempotent on retries.",
      parameters: Type.Object({ id: Id, occurredAt: Type.Optional(Type.String({ format: "date-time" })), idempotencyKey: Type.Optional(IdempotencyKey) }),
      execute: (params, config) => healthFetch(config, `/v1/meals/pending/${params.id}/confirm`, { method: "POST", body: { ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}), ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}) } }),
    }),
    tool({
      name: "log_meal",
      description: "Persist a user-confirmed meal estimate. Never call before explicit confirmation unless the original request explicitly said to log it.",
      parameters: LoggedMeal,
      execute: (params, config) => healthFetch(config, "/v1/meals", { method: "POST", body: params }),
    }),
    tool({ name: "get_meal", description: "Get one meal by its database ID.", parameters: Type.Object({ id: Id }), execute: (params, config) => healthFetch(config, `/v1/meals/${params.id}`) }),
    tool({ name: "get_recent_meals", description: "List recent meals so natural-language references can be resolved to an ID.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: (params, config) => healthFetch(config, `/v1/meals/recent?limit=${params.limit ?? 20}`) }),
    tool({
      name: "update_meal",
      description: "Correct an existing meal by ID. Use this for calorie, quantity, macro, confidence, label, or time corrections.",
      parameters: Type.Object({ id: Id, patch: Type.Partial(Type.Object({ occurredAt: Type.String({ format: "date-time" }), label: Type.String(), caloriesBest: Type.Integer({ minimum: 0 }), caloriesLow: Type.Integer({ minimum: 0 }), caloriesHigh: Type.Integer({ minimum: 0 }), proteinG: Type.Number({ minimum: 0 }), carbsG: Type.Number({ minimum: 0 }), fatG: Type.Number({ minimum: 0 }), fiberG: NullableNumber, confidence: Confidence, uncertaintyReasons: Type.Array(Type.String()) })) }),
      execute: (params, config) => healthFetch(config, `/v1/meals/${params.id}`, { method: "PATCH", body: params.patch }),
    }),
    tool({ name: "delete_meal", description: "Delete one existing meal by ID.", parameters: Type.Object({ id: Id }), execute: (params, config) => healthFetch(config, `/v1/meals/${params.id}`, { method: "DELETE" }) }),
    tool({ name: "get_daily_nutrition", description: "Read database-backed meals and deterministic nutrition totals for a local calendar date.", parameters: Type.Object({ date: Type.String({ format: "date" }), timezone: Type.Optional(Type.String({ default: "Asia/Kuala_Lumpur" })) }), execute: (params, config) => healthFetch(config, `/v1/nutrition/daily?date=${encodeURIComponent(params.date)}&timezone=${encodeURIComponent(params.timezone ?? "Asia/Kuala_Lumpur")}`) }),
    tool({ name: "save_food_preset", description: "Save or replace a user-confirmed repeated food preset.", parameters: Type.Object({ name: Type.String(), meal: PresetMeal }), execute: (params, config) => healthFetch(config, "/v1/food-presets", { method: "POST", body: params }) }),
    tool({ name: "find_food_preset", description: "Find a saved food preset before estimating repeated food.", parameters: Type.Object({ query: Type.String() }), execute: (params, config) => healthFetch(config, `/v1/food-presets?query=${encodeURIComponent(params.query)}`) }),
    tool({ name: "update_food_preset", description: "Update fields on a saved food preset by ID.", parameters: Type.Object({ id: Id, patch: Type.Partial(Type.Object({ name: Type.String(), label: Type.String(), caloriesBest: Type.Integer({ minimum: 0 }), caloriesLow: Type.Integer({ minimum: 0 }), caloriesHigh: Type.Integer({ minimum: 0 }), proteinG: Type.Number({ minimum: 0 }), carbsG: Type.Number({ minimum: 0 }), fatG: Type.Number({ minimum: 0 }), fiberG: NullableNumber, confidence: Confidence, uncertaintyReasons: Type.Array(Type.String()) })) }), execute: (params, config) => healthFetch(config, `/v1/food-presets/${params.id}`, { method: "PATCH", body: params.patch }) }),
    tool({ name: "delete_food_preset", description: "Delete a saved food preset by ID.", parameters: Type.Object({ id: Id }), execute: (params, config) => healthFetch(config, `/v1/food-presets/${params.id}`, { method: "DELETE" }) }),
    tool({ name: "start_workout", description: "Start one active conversational workout session.", parameters: Type.Object({ name: Type.String(), startedAt: Type.Optional(Type.String({ format: "date-time" })), idempotencyKey: IdempotencyKey }), execute: (params, config) => healthFetch(config, "/v1/workouts", { method: "POST", body: params }) }),
    tool({ name: "get_active_workout", description: "Get the active workout and all current exercises and sets.", parameters: Type.Object({}), execute: (_params, config) => healthFetch(config, "/v1/workouts/active") }),
    tool({ name: "add_workout_set", description: "Add one set to an exercise in the active workout. Repeated shorthand should reuse the latest exercise and weight from tool state.", parameters: Type.Object({ workoutId: Id, exerciseName: Type.String(), weightKg: NullableNumber, reps: Type.Integer({ minimum: 1 }), rpe: Type.Optional(Type.Union([Type.Number({ minimum: 1, maximum: 10 }), Type.Null()])), notes: Type.Optional(Type.Union([Type.String(), Type.Null()])), occurredAt: Type.Optional(Type.String({ format: "date-time" })), idempotencyKey: IdempotencyKey }), execute: (params, config) => { const { workoutId, ...body } = params; return healthFetch(config, `/v1/workouts/${workoutId}/sets`, { method: "POST", body }); } }),
    tool({ name: "update_workout_set", description: "Correct an existing workout set by ID.", parameters: Type.Object({ id: Id, patch: Type.Partial(Type.Object({ weightKg: NullableNumber, reps: Type.Integer({ minimum: 1 }), rpe: Type.Union([Type.Number({ minimum: 1, maximum: 10 }), Type.Null()]), notes: Type.Union([Type.String(), Type.Null()]) })) }), execute: (params, config) => healthFetch(config, `/v1/workout-sets/${params.id}`, { method: "PATCH", body: params.patch }) }),
    tool({ name: "delete_workout_set", description: "Delete an existing workout set by ID.", parameters: Type.Object({ id: Id }), execute: (params, config) => healthFetch(config, `/v1/workout-sets/${params.id}`, { method: "DELETE" }) }),
    tool({ name: "finish_workout", description: "Finish the active workout and return deterministic totals.", parameters: Type.Object({ id: Id, finishedAt: Type.Optional(Type.String({ format: "date-time" })) }), execute: (params, config) => healthFetch(config, `/v1/workouts/${params.id}/finish`, { method: "POST", body: params.finishedAt ? { finishedAt: params.finishedAt } : {} }) }),
    tool({ name: "get_previous_exercise_performance", description: "Get the most recent prior performance for an exercise.", parameters: Type.Object({ name: Type.String(), before: Type.Optional(Type.String({ format: "date-time" })) }), execute: (params, config) => healthFetch(config, `/v1/exercises/previous?name=${encodeURIComponent(params.name)}${params.before ? `&before=${encodeURIComponent(params.before)}` : ""}`) }),
    tool({ name: "get_workout_history", description: "List recent workouts with exercises, sets, volume, and estimated 1RM values.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: (params, config) => healthFetch(config, `/v1/workouts/history?limit=${params.limit ?? 20}`) }),
  ],
});

const lastPromptBySession = new Map<string, string>();
const blockedRuns = new Set<string>();
const toolStartTimes = new Map<string, number>();

const registerTools = plugin.register;
plugin.register = (api) => {
  registerTools(api);

  api.on(
    "before_prompt_build",
    (event, context) => {
      const sessionKey = context.sessionKey ?? context.sessionId ?? "default";
      lastPromptBySession.set(sessionKey, event.prompt);
      if (context.runId) {
        api.runContext.setRunContext({ runId: context.runId, namespace: "currentPrompt", value: event.prompt });
        blockedRuns.delete(context.runId);
      }
      if (context.sessionKey) {
        api.runContext.setRunContext({ runId: context.sessionKey, namespace: "currentPrompt", value: event.prompt });
      }
      return { appendSystemContext: healthTrackingGuidance };
    },
    { priority: 50 },
  );

  api.on(
    "before_tool_call",
    (event, context) => {
      const toolKey = `${context.runId ?? ""}_${event.toolName}_${event.toolCallId ?? ""}`;
      toolStartTimes.set(toolKey, performance.now());

      if (event.toolName !== "log_meal" && event.toolName !== "confirm_pending_meal") return;

      if (context.runId && blockedRuns.has(context.runId)) {
        return {
          block: true,
          blockReason: "Meal draft already rejected as unconfirmed in this turn. Reply to the user with the estimated calories/macros and ask if they would like you to log it.",
        };
      }

      const fromRun = context.runId ? (api.runContext.getRunContext({ runId: context.runId, namespace: "currentPrompt" }) as string | undefined) : undefined;
      const fromSession = context.sessionKey ? (api.runContext.getRunContext({ runId: context.sessionKey, namespace: "currentPrompt" }) as string | undefined) : undefined;
      const fromCache = lastPromptBySession.get(context.sessionKey ?? context.sessionId ?? "default");
      const rawUserText = typeof event.params?.rawUserText === "string" ? event.params.rawUserText : undefined;

      const candidates = [fromRun, fromSession, fromCache, rawUserText].filter(Boolean) as string[];
      const isConfirmed = candidates.some((prompt) => isMealLogConfirmation(prompt));

      if (!isConfirmed) {
        if (context.runId) blockedRuns.add(context.runId);
        return {
          block: true,
          blockReason: "Meal draft is not yet confirmed by the user. Do not call log_meal again in this turn. Present the estimated calories, macros, and confidence to the user and ask 'Would you like me to log this?'",
        };
      }
    },
    { priority: 100 },
  );

  api.on(
    "after_tool_call",
    (event, context) => {
      const toolKey = `${context.runId ?? ""}_${event.toolName}_${event.toolCallId ?? ""}`;
      const start = toolStartTimes.get(toolKey);
      if (start !== undefined) {
        toolStartTimes.delete(toolKey);
        const durationMs = Math.round(performance.now() - start);
        console.log(`[LATENCY] runId=${context.runId ?? "unknown"} tool=${event.toolName} durationMs=${durationMs}`);
      }
    },
    { priority: 100 },
  );

  api.on(
    "reply_payload_sending",
    (event) => {
      if (event.payload?.isFallbackNotice || (typeof event.payload?.text === "string" && isFallbackNotice(event.payload.text))) {
        return { cancel: true, reason: "silent-fallback" };
      }
      if (typeof event.payload?.text === "string") {
        const sanitized = sanitizeUserFacingError(event.payload.text);
        if (sanitized !== event.payload.text) {
          event.payload.text = sanitized;
        }
      }
    },
    { priority: 100 },
  );

  api.on(
    "before_agent_reply",
    (event) => {
      if (isFallbackNotice(event.cleanedBody)) {
        return { handled: true, reply: { text: "" }, reason: "silent-fallback" };
      }
      const sanitized = sanitizeUserFacingError(event.cleanedBody);
      if (sanitized !== event.cleanedBody) {
        return { handled: true, reply: { text: sanitized } };
      }
    },
    { priority: 100 },
  );
};

export default plugin;

const healthTrackingGuidance = `
ClawFit health tracking policy:
- The Health API/database is authoritative. Use the ClawFit tools for meal/workout state, and never claim a write succeeded unless its tool call succeeded.
- Treat clear workout phrases as actions without unnecessary clarification: "starting push" starts a Push workout; "bench 80 x 8" adds that set; "8 again" reuses the latest exercise and weight; "only got 6" adds another set unless explicitly called a correction. Resolve current state with get_active_workout when needed.
- Corrections update the existing meal or workout-set ID after resolving it from recent/active state. Never create a replacement. Reuse a stable idempotency key when retrying a create action.
- Perform only the action in the latest user message. Earlier unanswered or failed user messages are context, not queued actions: never replay them. A retry of the same current action must reuse its original idempotency key.
- A meal estimate is a draft. For simple quantified foods, create and show a reasonable estimate without estimate_nutrition. Use estimate_nutrition once only for difficult restaurant/photo/mixed meals. Do not call log_meal until the user confirms, unless their first message explicitly asks to log/save/track it.
- Preserve the complete structured meal draft for the confirmation turn. A bare "yes" or "log it" applies to the immediately preceding draft; call log_meal (or confirm_pending_meal) and never invoke an unrelated workout tool.
- Show calorie best/low/high, macros, confidence, and meaningful uncertainty. Use get_daily_nutrition for daily food/totals rather than calculating them yourself.
- Use deterministic volume and estimated 1RM returned by the tools. Nutrition is an estimate, not medical advice.
`;

async function healthFetch(config: { apiUrl?: string }, path: string, options: { method?: string; body?: unknown } = {}) {
  const token = process.env.HEALTH_API_TOKEN;
  if (!token) throw new Error("HEALTH_API_TOKEN is not available to the OpenClaw Gateway");
  const apiUrl = config.apiUrl ?? process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
  const start = performance.now();
  const response = await fetch(new URL(path, apiUrl), {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const dur = Math.round(performance.now() - start);
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } };
    throw new Error(`${error.error?.code ?? "HEALTH_API_ERROR"}: ${error.error?.message ?? `Health API returned ${response.status}`}`);
  }
  if (dur > 200) {
    console.log(`[LATENCY] healthFetch path=${path} durationMs=${dur}`);
  }
  return payload;
}
