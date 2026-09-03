import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import {
  confirmPendingMealSchema,
  mealInputSchema,
  mealPatchSchema,
  notificationPreferenceSchema,
  NutritionEstimator,
  pendingMealInputSchema,
  pendingMealPatchSchema,
  pendingMealScopeSchema,
  settingsPatchSchema,
  startWorkoutSchema,
  workoutSetInputSchema,
  workoutSetPatchSchema,
} from "@clawfit/health-core";
import { ConflictError, DEFAULT_PRIMARY_USER_ID, HealthRepository, NotFoundError } from "@clawfit/db";

const uuidParam = z.object({ id: z.string().uuid() });
const dateQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.string().min(1).default("Asia/Kuala_Lumpur") });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export function createApp(options: {
  repository: HealthRepository;
  apiToken: string;
  estimator?: NutritionEstimator;
  logger?: boolean;
}) {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ["req.headers.authorization", "headers.x-goog-api-key"] } });
  const compatibilityUserId = DEFAULT_PRIMARY_USER_ID;

  app.addHook("onRequest", async (request, reply) => {
    (request as unknown as { startTime: number }).startTime = performance.now();
    if (request.url === "/health" || request.url === "/ready") return;
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeEqual(provided, options.apiToken)) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required" } });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as unknown as { startTime?: number }).startTime;
    if (typeof startTime === "number") {
      const dur = Math.round(performance.now() - startTime);
      reply.header("Server-Timing", `total;dur=${dur}`);
      if (options.logger !== false && request.url !== "/health" && request.url !== "/ready") {
        app.log.info({ method: request.method, url: request.url, status: reply.statusCode, durationMs: dur }, "request completed");
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: "INVALID_PAYLOAD", message: "Request validation failed", details: error.issues } });
    }
    if (error instanceof NotFoundError) return reply.code(404).send({ error: { code: "NOT_FOUND", message: error.message } });
    if (error instanceof ConflictError) return reply.code(409).send({ error: { code: "CONFLICT", message: error.message } });
    app.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.repository.checkReady();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/v1/nutrition/estimate", async (request) => {
    if (!options.estimator) throw new ConflictError("Nutrition estimator is not configured");
    const body = z
      .object({
        text: z.string().max(4_000).default(""),
        image: z.object({ mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]), base64: z.string().max(16_000_000) }).optional(),
      })
      .refine((value) => value.text.length > 0 || value.image, "Text or image is required")
      .parse(request.body);
    return options.estimator.estimate({ text: body.text, ...(body.image ? { image: body.image } : {}) });
  });

  app.post("/v1/meals", async (request, reply) => {
    const input = mealInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.createMeal(compatibilityUserId, input));
  });
  app.post("/v1/meals/pending", async (request, reply) => {
    const input = pendingMealInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.createPendingMeal(compatibilityUserId, input));
  });
  app.get("/v1/meals/pending/latest", async (request) => {
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return { pending: await options.repository.getLatestPendingMeal(compatibilityUserId, scopeKey) };
  });
  app.get("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.getPendingMeal(compatibilityUserId, id, scopeKey);
  });
  app.patch("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const body = pendingMealPatchSchema.and(pendingMealScopeSchema).parse(request.body);
    const { scopeKey, ...patch } = body;
    return options.repository.updatePendingMeal(compatibilityUserId, id, scopeKey, patch);
  });
  app.delete("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.cancelPendingMeal(compatibilityUserId, id, scopeKey);
  });
  app.post("/v1/meals/pending/:id/confirm", async (request, reply) => {
    const params = uuidParam.parse(request.params);
    const body = confirmPendingMealSchema.parse(request.body ?? {});
    return reply.code(200).send(await options.repository.confirmPendingMeal(compatibilityUserId, params.id, body));
  });
  app.get("/v1/meals/recent", async (request) => {
    const limit = listQuery.parse(request.query).limit;
    return options.repository.listRecentMeals(compatibilityUserId, limit);
  });
  app.get("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.getMeal(compatibilityUserId, id);
  });
  app.patch("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = mealPatchSchema.parse(request.body);
    return options.repository.updateMeal(compatibilityUserId, id, patch);
  });
  app.delete("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteMeal(compatibilityUserId, id);
  });
  app.get("/v1/nutrition/daily", async (request) => {
    const query = dateQuery.parse(request.query);
    const { start, end } = zonedDayRange(query.date, query.timezone);
    const result = await options.repository.dailyNutrition(compatibilityUserId, start, end);
    return { ...result, date: query.date };
  });
  app.get("/v1/nutrition/trend", async (request) => {
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query);
    const end = new Date();
    const start = new Date(end.getTime() - query.days * 86_400_000);
    return options.repository.nutritionTrend(compatibilityUserId, start, end);
  });

  app.post("/v1/food-presets", async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(160), meal: mealInputSchema }).parse(request.body);
    return reply.code(201).send(await options.repository.savePreset(compatibilityUserId, body.name, body.meal));
  });
  app.get("/v1/food-presets", async (request) => {
    const query = z.object({ query: z.string().max(160).default("") }).parse(request.query).query;
    return options.repository.findPresets(compatibilityUserId, query);
  });
  app.patch("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const parsed = presetPatchSchema.parse(request.body);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as Parameters<HealthRepository["updatePreset"]>[2];
    return options.repository.updatePreset(compatibilityUserId, id, patch);
  });
  app.delete("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deletePreset(compatibilityUserId, id);
  });

  app.post("/v1/workouts", async (request, reply) => {
    const body = startWorkoutSchema.parse(request.body);
    const payload = { name: body.name, idempotencyKey: body.idempotencyKey, ...(body.startedAt ? { startedAt: body.startedAt } : {}) };
    return reply.code(201).send(await options.repository.startWorkout(compatibilityUserId, payload));
  });
  app.get("/v1/workouts/active", async () => {
    return options.repository.getActiveWorkout(compatibilityUserId);
  });
  app.get("/v1/workouts/history", async (request) => {
    const limit = listQuery.parse(request.query).limit;
    return options.repository.workoutHistory(compatibilityUserId, limit);
  });
  app.get("/v1/workouts/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.getWorkout(compatibilityUserId, id);
  });
  app.post("/v1/workouts/:id/sets", async (request, reply) => {
    const id = uuidParam.parse(request.params).id;
    const body = workoutSetInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.addWorkoutSet(compatibilityUserId, id, body));
  });
  app.patch("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = workoutSetPatchSchema.parse(request.body);
    return options.repository.updateWorkoutSet(compatibilityUserId, id, patch);
  });
  app.delete("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteWorkoutSet(compatibilityUserId, id);
  });
  app.post("/v1/workouts/:id/finish", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const body = z.object({ finishedAt: z.coerce.date().optional() }).parse(request.body ?? {});
    return options.repository.finishWorkout(compatibilityUserId, id, body.finishedAt);
  });
  app.get("/v1/exercises/previous", async (request) => {
    const query = z.object({ name: z.string().min(1), before: z.coerce.date().optional() }).parse(request.query);
    return options.repository.previousExercisePerformance(compatibilityUserId, query.name, query.before);
  });
  app.get("/v1/exercises/history", async (request) => {
    const query = z.object({ name: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return options.repository.exerciseHistory(compatibilityUserId, query.name, query.limit);
  });

  app.get("/v1/settings", async () => {
    return options.repository.getSettings(compatibilityUserId);
  });
  app.patch("/v1/settings", async (request) => {
    const patch = settingsPatchSchema.parse(request.body);
    return options.repository.updateSettings(compatibilityUserId, patch);
  });
  app.get("/v1/notification-preferences", async () => {
    return options.repository.listNotificationPreferences(compatibilityUserId);
  });
  app.put("/v1/notification-preferences/:type", async (request) => {
    const type = z.string().parse((request.params as { type?: unknown }).type);
    const preference = notificationPreferenceSchema.parse({ ...(request.body as object), type });
    return options.repository.upsertNotificationPreference(compatibilityUserId, preference);
  });

  return app;
}

const presetPatchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  label: z.string().min(1).max(300).optional(),
  caloriesBest: z.number().int().nonnegative().max(20_000).optional(),
  caloriesLow: z.number().int().nonnegative().max(20_000).optional(),
  caloriesHigh: z.number().int().nonnegative().max(20_000).optional(),
  proteinG: z.number().nonnegative().max(2_000).optional(),
  carbsG: z.number().nonnegative().max(3_000).optional(),
  fatG: z.number().nonnegative().max(2_000).optional(),
  fiberG: z.number().nonnegative().max(500).nullable().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  uncertaintyReasons: z.array(z.string().min(1).max(300)).max(20).optional(),
});

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function zonedDayRange(date: string, timezone: string) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  return { start: zonedDateToUtc(date, timezone), end: zonedDateToUtc(nextDate, timezone) };
}

function zonedDateToUtc(date: string, timezone: string) {
  const target = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return new Date(target.getTime() - (represented - target.getTime()));
}
