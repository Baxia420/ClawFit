import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  confirmPendingMealSchema,
  foodPresetPatchSchema,
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

declare module "fastify" {
  interface FastifyRequest {
    userId?: string | undefined;
    clientType?: "web" | "openclaw" | undefined;
    startTime?: number | undefined;
  }
}

export type CreateAppOptions = {
  repository: HealthRepository;
  apiToken?: string | undefined;
  webToken?: string | undefined;
  openclawToken?: string | undefined;
  allowedGroupIds?: string[] | undefined;
  estimator?: NutritionEstimator | undefined;
  logger?: boolean | undefined;
};

export function createApp(options: CreateAppOptions) {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ["req.headers.authorization", "headers.x-goog-api-key"] } });
  const compatibilityUserId = DEFAULT_PRIMARY_USER_ID;

  app.decorateRequest("userId", undefined);
  app.decorateRequest("clientType", undefined);

  const getUserId = (request: FastifyRequest): string => request.userId || compatibilityUserId;

  app.addHook("onRequest", async (request, reply) => {
    (request as unknown as { startTime: number }).startTime = performance.now();
    if (request.url === "/health" || request.url === "/ready") return;

    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

    const webToken = options.webToken ?? options.apiToken ?? "";
    const openclawToken = options.openclawToken ?? options.apiToken ?? "";

    const isWeb = Boolean(webToken && safeEqual(provided, webToken));
    const isOpenClaw = Boolean(openclawToken && safeEqual(provided, openclawToken));

    if (!isWeb && !isOpenClaw) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required" } });
    }

    const senderProviderHeader = request.headers["x-clawfit-sender-provider"];
    const senderIdHeader = request.headers["x-clawfit-sender-id"];
    const conversationIdHeader = request.headers["x-clawfit-conversation-id"];

    const senderProvider = typeof senderProviderHeader === "string" ? senderProviderHeader : undefined;
    const senderId = typeof senderIdHeader === "string" ? senderIdHeader : undefined;
    const conversationId = typeof conversationIdHeader === "string" ? conversationIdHeader : undefined;

    // Web client handling
    if (isWeb && !isOpenClaw) {
      if (senderId || senderProvider) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Sender headers not permitted for web client" } });
      }
      (request as unknown as { clientType: string }).clientType = "web";
      (request as unknown as { userId: string }).userId = compatibilityUserId;
      return;
    }

    // OpenClaw client handling (or dual-configured dev fallback)
    (request as unknown as { clientType: string }).clientType = "openclaw";

    // If conversation is a WhatsApp group (@g.us), enforce allowlist
    if (conversationId && conversationId.includes("@g.us")) {
      const allowed = options.allowedGroupIds ?? [];
      if (!allowed.includes(conversationId)) {
        return reply.code(403).send({
          error: {
            code: "UNAUTHORIZED_GROUP",
            message: "This WhatsApp group is not authorized for ClawFit health tracking.",
          },
        });
      }
    }

    // Public ML estimate route does not require user DB lookup
    if (request.url === "/v1/nutrition/estimate" && !senderId) {
      return;
    }

    // All health data routes require valid, resolved sender
    if (!senderId) {
      // In backwards-compatibility mode (single token without sender headers from legacy caller)
      if (isWeb) {
        (request as unknown as { clientType: string }).clientType = "web";
        (request as unknown as { userId: string }).userId = compatibilityUserId;
        return;
      }
      return reply.code(403).send({
        error: {
          code: "MISSING_SENDER_IDENTITY",
          message: "Missing sender identity header",
        },
      });
    }

    const resolution = await options.repository.resolveUser({
      provider: senderProvider ?? "whatsapp",
      externalIdentifier: senderId,
    });

    if (!resolution.resolved) {
      if (resolution.reason === "user_inactive_or_missing") {
        return reply.code(403).send({
          error: {
            code: "INACTIVE_USER",
            message: "This ClawFit profile is inactive.",
          },
        });
      }
      return reply.code(403).send({
        error: {
          code: "UNRESOLVED_SENDER_IDENTITY",
          message: "This WhatsApp account isn't linked to a ClawFit profile yet.",
        },
      });
    }

    (request as unknown as { userId: string }).userId = resolution.user.id;
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
    return reply.code(201).send(await options.repository.createMeal(getUserId(request), input));
  });
  app.post("/v1/meals/pending", async (request, reply) => {
    const input = pendingMealInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.createPendingMeal(getUserId(request), input));
  });
  app.get("/v1/meals/pending/latest", async (request) => {
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return { pending: await options.repository.getLatestPendingMeal(getUserId(request), scopeKey) };
  });
  app.get("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.getPendingMeal(getUserId(request), id, scopeKey);
  });
  app.patch("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const body = pendingMealPatchSchema.and(pendingMealScopeSchema).parse(request.body);
    const { scopeKey, ...patch } = body;
    return options.repository.updatePendingMeal(getUserId(request), id, scopeKey, patch);
  });
  app.delete("/v1/meals/pending/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.cancelPendingMeal(getUserId(request), id, scopeKey);
  });
  app.post("/v1/meals/pending/:id/confirm", async (request, reply) => {
    const params = uuidParam.parse(request.params);
    const body = confirmPendingMealSchema.parse(request.body ?? {});
    return reply.code(200).send(await options.repository.confirmPendingMeal(getUserId(request), params.id, body));
  });
  app.get("/v1/meals/recent", async (request) => {
    const limit = listQuery.parse(request.query).limit;
    return options.repository.listRecentMeals(getUserId(request), limit);
  });
  app.get("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.getMeal(getUserId(request), id);
  });
  app.patch("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = mealPatchSchema.parse(request.body);
    return options.repository.updateMeal(getUserId(request), id, patch);
  });
  app.delete("/v1/meals/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteMeal(getUserId(request), id);
  });
  app.get("/v1/nutrition/daily", async (request) => {
    const query = dateQuery.parse(request.query);
    const { start, end } = zonedDayRange(query.date, query.timezone);
    const result = await options.repository.dailyNutrition(getUserId(request), start, end);
    return { ...result, date: query.date };
  });
  app.get("/v1/nutrition/trend", async (request) => {
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query);
    const end = new Date();
    const start = new Date(end.getTime() - query.days * 86_400_000);
    return options.repository.nutritionTrend(getUserId(request), start, end);
  });

  app.post("/v1/food-presets", async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(160), meal: mealInputSchema }).parse(request.body);
    return reply.code(201).send(await options.repository.savePreset(getUserId(request), body.name, body.meal));
  });
  app.get("/v1/food-presets", async (request) => {
    const query = z.object({ query: z.string().max(160).default("") }).parse(request.query).query;
    return options.repository.findPresets(getUserId(request), query);
  });
  app.patch("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = foodPresetPatchSchema.parse(request.body);
    return options.repository.updatePreset(getUserId(request), id, patch);
  });
  app.delete("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deletePreset(getUserId(request), id);
  });

  app.post("/v1/workouts", async (request, reply) => {
    const body = startWorkoutSchema.parse(request.body);
    const payload = { name: body.name, idempotencyKey: body.idempotencyKey, ...(body.startedAt ? { startedAt: body.startedAt } : {}) };
    return reply.code(201).send(await options.repository.startWorkout(getUserId(request), payload));
  });
  app.get("/v1/workouts/active", async (request) => {
    return options.repository.getActiveWorkout(getUserId(request));
  });
  app.get("/v1/workouts/history", async (request) => {
    const limit = listQuery.parse(request.query).limit;
    return options.repository.workoutHistory(getUserId(request), limit);
  });
  app.get("/v1/workouts/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.getWorkout(getUserId(request), id);
  });
  app.post("/v1/workouts/:id/sets", async (request, reply) => {
    const id = uuidParam.parse(request.params).id;
    const body = workoutSetInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.addWorkoutSet(getUserId(request), id, body));
  });
  app.patch("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = workoutSetPatchSchema.parse(request.body);
    return options.repository.updateWorkoutSet(getUserId(request), id, patch);
  });
  app.delete("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteWorkoutSet(getUserId(request), id);
  });
  app.post("/v1/workouts/:id/finish", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const body = z.object({ finishedAt: z.coerce.date().optional() }).parse(request.body ?? {});
    return options.repository.finishWorkout(getUserId(request), id, body.finishedAt);
  });
  app.get("/v1/exercises/previous", async (request) => {
    const query = z.object({ name: z.string().min(1), before: z.coerce.date().optional() }).parse(request.query);
    return options.repository.previousExercisePerformance(getUserId(request), query.name, query.before);
  });
  app.get("/v1/exercises/history", async (request) => {
    const query = z.object({ name: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return options.repository.exerciseHistory(getUserId(request), query.name, query.limit);
  });

  app.get("/v1/settings", async (request) => {
    return options.repository.getSettings(getUserId(request));
  });
  app.patch("/v1/settings", async (request) => {
    const patch = settingsPatchSchema.parse(request.body);
    return options.repository.updateSettings(getUserId(request), patch);
  });
  app.get("/v1/notification-preferences", async (request) => {
    return options.repository.listNotificationPreferences(getUserId(request));
  });
  app.put("/v1/notification-preferences/:type", async (request) => {
    const type = z.string().parse((request.params as { type?: unknown }).type);
    const preference = notificationPreferenceSchema.parse({ ...(request.body as object), type });
    return options.repository.upsertNotificationPreference(getUserId(request), preference);
  });

  return app;
}

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
