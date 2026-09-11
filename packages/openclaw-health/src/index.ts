import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static, type TSchema } from "typebox";
import { isFallbackNotice, isMealLogConfirmation, sanitizeUserFacingError } from "./confirmation.js";
import { derivePendingMealScope, healthFetch, withPendingMealScope, type SenderContext } from "./health-client.js";
import { resolveImagePayload, MediaResolutionError, type MediaAuthorizationContext, type ResolvedImage } from "./media-resolver.js";

const ConfigSchema = Type.Object({
  apiUrl: Type.Optional(Type.String({ default: "http://127.0.0.1:4000" })),
  allowedGroupIds: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
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
const PendingMealDraft = Type.Object({
  ...EstimateFields,
  occurredAt: Type.String({ format: "date-time" }),
  source: Type.Union([Type.Literal("text"), Type.Literal("photo"), Type.Literal("preset"), Type.Literal("manual")]),
  rawUserText: Type.Union([Type.String(), Type.Null()]),
  idempotencyKey: IdempotencyKey,
});
const PendingMealLookup = Type.Object({ id: Type.Optional(Id) });

function createSenderTool<TParams extends TSchema>(
  tool: any,
  options: {
    name: string;
    description: string;
    parameters: TParams;
    execute: (
      params: Static<TParams>,
      context: {
        config: Static<typeof ConfigSchema>;
        sender: SenderContext;
        toolContext: any;
        signal?: AbortSignal;
      },
    ) => Promise<unknown>;
  },
) {
  return tool({
    name: options.name,
    label: options.name,
    description: options.description,
    parameters: options.parameters,
    factory: ({ config, toolContext }: { config: Static<typeof ConfigSchema>; toolContext: any }) => {
      const senderId = toolContext?.requesterSenderId;
      const conversationId = toolContext?.deliveryContext?.to;
      const provider = toolContext?.messageChannel ?? "whatsapp";

      return {
        name: options.name,
        label: options.name,
        description: options.description,
        parameters: options.parameters,
        execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
          if (!conversationId) {
            return jsonResult({
              error: "Missing WhatsApp conversation context. Request cannot be processed.",
            });
          }

          if (conversationId.includes("@g.us")) {
            const allowedGroupIds = config?.allowedGroupIds ??
              (process.env.CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS
                ? process.env.CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS.split(",").map((s) => s.trim()).filter(Boolean)
                : []);
            if (!allowedGroupIds.includes(conversationId)) {
              return jsonResult({
                error: "This WhatsApp group is not authorized for ClawFit health tracking.",
              });
            }
          }

          if (!senderId) {
            return jsonResult({
              error: "This WhatsApp account isn't linked to a ClawFit profile yet.",
            });
          }

          const sender: SenderContext = {
            provider,
            senderId,
            conversationId,
          };

          try {
            const result = await options.execute(rawParams as Static<TParams>, {
              config,
              sender,
              toolContext,
              ...(signal ? { signal } : {}),
            });
            return jsonResult(result);
          } catch (err) {
            const message = (err as Error).message;
            if (message.includes("UNRESOLVED_SENDER_IDENTITY:") || message.includes("isn't linked to a ClawFit profile yet")) {
              return jsonResult({ error: "This WhatsApp account isn't linked to a ClawFit profile yet." });
            }
            if (message.includes("INACTIVE_USER:") || message.includes("profile is inactive")) {
              return jsonResult({ error: "This ClawFit profile is inactive. Please contact the household administrator." });
            }
            if (message.includes("UNAUTHORIZED_GROUP:") || message.includes("not authorized")) {
              return jsonResult({ error: "This WhatsApp group is not authorized for ClawFit health tracking." });
            }
            throw err;
          }
        },
      };
    },
  });
}

const plugin = defineToolPlugin({
  id: "clawfit-health",
  name: "ClawFit Health",
  description: "Authenticated domain tools for nutrition and workout tracking.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    createSenderTool(tool, {
      name: "estimate_nutrition",
      description: "Estimate a difficult or uncertain meal synchronously via the strong nutrition model. This returns a draft only; it does not log anything.",
      parameters: Type.Object({
        text: Type.String({ description: "Meal description and all visual details available from attached photo(s)." }),
        imagePath: Type.Optional(Type.String({ description: "Optional local path or media URI (e.g. media://inbound/<id>) of the meal image to analyze." })),
        imagePaths: Type.Optional(Type.Array(Type.String(), { description: "Optional local paths or media URIs of attached meal images (e.g. package front + nutrition label)." })),
        imageBase64: Type.Optional(Type.String({ description: "Optional raw base64 image data when the active client can provide it." })),
        imageMimeType: Type.Optional(Type.String({ description: "MIME type paired with imageBase64." })),
        images: Type.Optional(Type.Array(Type.Object({ base64: Type.String(), mimeType: Type.String() }), { description: "Optional multiple images (e.g. package front + nutrition label)." })),
      }),
      execute: async (params, { config, sender, toolContext, signal }) => {
        const rawCtx = toolContext as Record<string, unknown> | undefined;
        const authContext: MediaAuthorizationContext = {
          senderId: sender.senderId,
          conversationId: sender.conversationId,
          workspaceDir: typeof rawCtx?.workspaceDir === "string" ? rawCtx.workspaceDir : undefined,
          ...(rawCtx?.authContext as MediaAuthorizationContext | undefined),
          ...(Array.isArray(rawCtx?.authorizedMediaPaths) ? { authorizedMediaPaths: rawCtx.authorizedMediaPaths as string[] } : {}),
          ...(Array.isArray(rawCtx?.authorizedMediaUrls) ? { authorizedMediaUrls: rawCtx.authorizedMediaUrls as string[] } : {}),
          ...(typeof rawCtx?.mediaPath === "string" ? { mediaPath: rawCtx.mediaPath as string } : {}),
          ...(Array.isArray(rawCtx?.mediaPaths) ? { mediaPaths: rawCtx.mediaPaths as string[] } : {}),
          ...(typeof rawCtx?.mediaUrl === "string" ? { mediaUrl: rawCtx.mediaUrl as string } : {}),
          ...(Array.isArray(rawCtx?.mediaUrls) ? { mediaUrls: rawCtx.mediaUrls as string[] } : {}),
          ...(Array.isArray(rawCtx?.inboundMedia) ? { inboundMedia: rawCtx.inboundMedia as any } : {}),
          ...(Array.isArray(rawCtx?.authorizedAttachments)
            ? { authorizedAttachments: rawCtx.authorizedAttachments as any }
            : Array.isArray(rawCtx?.attachments)
              ? { authorizedAttachments: rawCtx.attachments as any }
              : {}),
        };

        let resolved: { images?: ResolvedImage[]; image?: ResolvedImage };
        try {
          resolved = await resolveImagePayload({
            imagePath: params.imagePath,
            imagePaths: params.imagePaths,
            imageBase64: params.imageBase64,
            imageMimeType: params.imageMimeType,
            images: params.images,
            authContext,
          });
        } catch (err) {
          if (err instanceof MediaResolutionError) {
            return {
              error: err.code,
              message: err.message,
            };
          }
          throw err;
        }

        return healthFetch(config, "/v1/nutrition/estimate", {
          method: "POST",
          body: {
            text: params.text,
            ...(resolved.images && resolved.images.length > 1
              ? { images: resolved.images }
              : resolved.image
                ? { image: resolved.image }
                : resolved.images && resolved.images.length === 1 && resolved.images[0]
                  ? { image: resolved.images[0] }
                  : {}),
          },
          sender,
          ...(signal ? { signal } : {}),
        });
      },
    }),
    createSenderTool(tool, {
      name: "create_pending_meal",
      description: "Persist a scoped meal draft for later confirmation. This never logs a meal and always expires after two hours.",
      parameters: PendingMealDraft,
      execute: (params, { config, sender, toolContext, signal }) => {
        const scopeKey = derivePendingMealScope(toolContext);
        return healthFetch(config, "/v1/meals/pending", {
          method: "POST",
          body: { ...params, scopeKey, expiresInSeconds: 7_200 },
          sender,
          ...(signal ? { signal } : {}),
        });
      },
    }),
    createSenderTool(tool, {
      name: "get_pending_meal",
      description: "Get this peer's active unconfirmed pending meal draft(s) across session boundaries. Returns the latest draft and all pending drafts in scope.",
      parameters: PendingMealLookup,
      execute: async (params, { config, sender, toolContext, signal }) => {
        const scopeKey = derivePendingMealScope(toolContext);
        if (params.id) {
          return healthFetch(config, withPendingMealScope(`/v1/meals/pending/${params.id}`, scopeKey), { sender, ...(signal ? { signal } : {}) });
        }
        const list = (await healthFetch(config, withPendingMealScope("/v1/meals/pending", scopeKey), { sender, ...(signal ? { signal } : {}) })) as { pending?: unknown[] };
        const latest = Array.isArray(list?.pending) && list.pending.length > 0 ? list.pending[0] : null;
        return {
          latest,
          pendingMeals: list?.pending ?? [],
        };
      },
    }),
    createSenderTool(tool, {
      name: "confirm_pending_meal",
      description: "Confirm and persist one or more existing meal drafts in this peer's scope. If id is omitted and count is omitted, confirms the latest active draft. For 'log both', provide count=2 or ids. Returns canonical confirmed meal ID(s).",
      parameters: Type.Object({
        id: Type.Optional(Id),
        ids: Type.Optional(Type.Array(Id)),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of drafts to confirm when user says 'log both' (e.g. count=2)." })),
        occurredAt: Type.Optional(Type.String({ format: "date-time" })),
        idempotencyKey: Type.Optional(IdempotencyKey),
        date: Type.Optional(Type.String({ format: "date", description: "Optional local calendar date (YYYY-MM-DD) to fetch updated daily totals immediately after confirming." })),
        timezone: Type.Optional(Type.String({ description: "Timezone for daily total calculation (default Asia/Kuala_Lumpur)." })),
      }),
      execute: async (params, { config, sender, toolContext, signal }) => {
        const scopeKey = derivePendingMealScope(toolContext);
        const targetIds: string[] = [];

        if (params.ids && params.ids.length > 0) {
          targetIds.push(...params.ids);
        } else if (params.id) {
          targetIds.push(params.id);
        } else if (params.count && params.count > 1) {
          const listRes = (await healthFetch(config, withPendingMealScope("/v1/meals/pending", scopeKey), { sender, ...(signal ? { signal } : {}) })) as { pending?: Array<{ id: string; label?: string; calories?: { best?: number }; occurredAt?: string }> };
          const pendingList = Array.isArray(listRes?.pending) ? listRes.pending : [];

          if (pendingList.length === 0) {
            return { error: "No active unconfirmed meal draft found to confirm." };
          }

          if (params.count === 2 && pendingList.length > 2) {
            return {
              error: "ambiguous_drafts",
              message: `There are ${pendingList.length} active unconfirmed meal drafts. Please specify which drafts to confirm by ID or meal name.`,
              pendingDrafts: pendingList.map((d) => ({
                id: d.id,
                label: d.label,
                calories: d.calories?.best,
                occurredAt: d.occurredAt,
              })),
            };
          }

          const toConfirm = pendingList.slice(0, params.count);
          targetIds.push(...toConfirm.map((d) => d.id));
        } else {
          const latestRes = (await healthFetch(config, withPendingMealScope("/v1/meals/pending/latest", scopeKey), { sender, ...(signal ? { signal } : {}) })) as { pending?: { id: string } | null };
          if (latestRes?.pending?.id) {
            targetIds.push(latestRes.pending.id);
          } else {
            return { error: "No active unconfirmed meal draft found to confirm." };
          }
        }

        if (targetIds.length === 1) {
          const targetId = targetIds[0]!;
          const res = (await healthFetch(config, `/v1/meals/pending/${targetId}/confirm`, {
            method: "POST",
            body: {
              scopeKey,
              ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
              ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
            },
            sender,
            ...(signal ? { signal } : {}),
          })) as { id: string; label?: string; calories?: { best?: number } };

          let dailyNutrition: unknown = undefined;
          let summaryError: string | undefined = undefined;
          if (params.date) {
            try {
              dailyNutrition = await healthFetch(
                config,
                `/v1/nutrition/daily?date=${encodeURIComponent(params.date)}&timezone=${encodeURIComponent(params.timezone ?? "Asia/Kuala_Lumpur")}`,
                { sender, ...(signal ? { signal } : {}) },
              );
            } catch (err) {
              summaryError = sanitizeUserFacingError((err as Error).message);
            }
          }

          return {
            ...res,
            confirmedMealId: res.id,
            pendingDraftId: targetId,
            status: "confirmed" as const,
            ...(dailyNutrition ? { dailyNutrition } : {}),
            ...(summaryError ? { summaryError } : {}),
            message: `Meal '${res.label ?? "Meal"}' confirmed with canonical ID ${res.id}. Future corrections must use update_meal with confirmedMealId.`,
          };
        }

        const confirmedMeals: Array<{
          confirmedMealId: string;
          pendingDraftId: string;
          status: "confirmed";
          label?: string | undefined;
          calories?: number | undefined;
          meal: unknown;
        }> = [];
        const failures: Array<{
          pendingDraftId: string;
          error: string;
          status: "failed";
        }> = [];

        for (const targetId of targetIds) {
          const idempotencyKey = params.idempotencyKey
            ? `${params.idempotencyKey}-${targetId}`
            : undefined;

          try {
            const res = (await healthFetch(config, `/v1/meals/pending/${targetId}/confirm`, {
              method: "POST",
              body: {
                scopeKey,
                ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
                ...(idempotencyKey ? { idempotencyKey } : {}),
              },
              sender,
              ...(signal ? { signal } : {}),
            })) as { id: string; label?: string; calories?: { best?: number } };
            confirmedMeals.push({
              confirmedMealId: res.id,
              pendingDraftId: targetId,
              status: "confirmed",
              label: res.label,
              calories: res.calories?.best,
              meal: res,
            });
          } catch (err) {
            failures.push({
              pendingDraftId: targetId,
              error: sanitizeUserFacingError((err as Error).message),
              status: "failed",
            });
          }
        }

        let dailyNutrition: unknown = undefined;
        let summaryError: string | undefined = undefined;
        if (params.date && confirmedMeals.length > 0) {
          try {
            dailyNutrition = await healthFetch(
              config,
              `/v1/nutrition/daily?date=${encodeURIComponent(params.date)}&timezone=${encodeURIComponent(params.timezone ?? "Asia/Kuala_Lumpur")}`,
              { sender, ...(signal ? { signal } : {}) },
            );
          } catch (err) {
            summaryError = sanitizeUserFacingError((err as Error).message);
          }
        }

        if (failures.length > 0 && confirmedMeals.length > 0) {
          return {
            status: "partial_success",
            partialSuccess: true,
            confirmedMeals,
            failures,
            ...(dailyNutrition ? { dailyNutrition } : {}),
            ...(summaryError ? { summaryError } : {}),
            message: `Partially confirmed: ${confirmedMeals.length} meal(s) confirmed, ${failures.length} failed. Unsuccessful drafts remain pending and can be retried safely.`,
          };
        }

        if (failures.length > 0 && confirmedMeals.length === 0) {
          return {
            status: "failed",
            error: "Failed to confirm pending meal(s).",
            failures,
          };
        }

        return {
          status: "confirmed" as const,
          confirmedMeals,
          ...(dailyNutrition ? { dailyNutrition } : {}),
          ...(summaryError ? { summaryError } : {}),
          message: `${confirmedMeals.length} meals confirmed. Future corrections must use update_meal with each confirmedMealId.`,
        };
      },
    }),
    createSenderTool(tool, {
      name: "update_pending_meal",
      description: "Correct fields on an unconfirmed meal draft by ID before confirmation. Never call update_meal for unconfirmed drafts.",
      parameters: Type.Object({
        id: Id,
        patch: Type.Partial(
          Type.Object({
            label: Type.String(),
            caloriesBest: Type.Integer({ minimum: 0 }),
            caloriesLow: Type.Integer({ minimum: 0 }),
            caloriesHigh: Type.Integer({ minimum: 0 }),
            proteinG: Type.Number({ minimum: 0 }),
            carbsG: Type.Number({ minimum: 0 }),
            fatG: Type.Number({ minimum: 0 }),
            fiberG: NullableNumber,
            confidence: Confidence,
            uncertaintyReasons: Type.Array(Type.String()),
          }),
        ),
      }),
      execute: (params, { config, sender, toolContext, signal }) => {
        const scopeKey = derivePendingMealScope(toolContext);
        return healthFetch(config, `/v1/meals/pending/${params.id}`, {
          method: "PATCH",
          body: { ...params.patch, scopeKey },
          sender,
          ...(signal ? { signal } : {}),
        });
      },
    }),
    createSenderTool(tool, {
      name: "log_meal",
      description: "Persist a user-confirmed meal estimate. Never call before explicit confirmation unless the original request explicitly said to log it.",
      parameters: LoggedMeal,
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, "/v1/meals", { method: "POST", body: params, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_meal",
      description: "Get one meal by its database ID.",
      parameters: Type.Object({ id: Id }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/meals/${params.id}`, { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_recent_meals",
      description: "List recent meals so natural-language references can be resolved to an ID.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/meals/recent?limit=${params.limit ?? 20}`, { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "update_meal",
      description: "Correct an existing confirmed/logged meal by its canonical confirmed meal ID (from log_meal, confirm_pending_meal, or get_recent_meals). Use this for calorie, quantity, macro, confidence, label, or time/date corrections ('that was yesterday'). For unconfirmed drafts, use update_pending_meal.",
      parameters: Type.Object({
        id: Id,
        patch: Type.Partial(
          Type.Object({
            occurredAt: Type.String({ format: "date-time" }),
            label: Type.String(),
            caloriesBest: Type.Integer({ minimum: 0 }),
            caloriesLow: Type.Integer({ minimum: 0 }),
            caloriesHigh: Type.Integer({ minimum: 0 }),
            proteinG: Type.Number({ minimum: 0 }),
            carbsG: Type.Number({ minimum: 0 }),
            fatG: Type.Number({ minimum: 0 }),
            fiberG: NullableNumber,
            confidence: Confidence,
            uncertaintyReasons: Type.Array(Type.String()),
          }),
        ),
        date: Type.Optional(Type.String({ format: "date", description: "Optional local calendar date (YYYY-MM-DD) to fetch updated daily totals immediately after updating." })),
        timezone: Type.Optional(Type.String({ description: "Timezone for daily total calculation (default Asia/Kuala_Lumpur)." })),
      }),
      execute: async (params, { config, sender, signal }) => {
        const updated = await healthFetch(config, `/v1/meals/${params.id}`, { method: "PATCH", body: params.patch, sender, ...(signal ? { signal } : {}) });
        let dailyNutrition: unknown = undefined;
        let summaryError: string | undefined = undefined;
        if (params.date) {
          try {
            dailyNutrition = await healthFetch(
              config,
              `/v1/nutrition/daily?date=${encodeURIComponent(params.date)}&timezone=${encodeURIComponent(params.timezone ?? "Asia/Kuala_Lumpur")}`,
              { sender, ...(signal ? { signal } : {}) },
            );
          } catch (err) {
            summaryError = sanitizeUserFacingError((err as Error).message);
          }
        }
        return {
          ...(typeof updated === "object" && updated !== null ? updated : { updated }),
          ...(dailyNutrition ? { dailyNutrition } : {}),
          ...(summaryError ? { summaryError } : {}),
        };
      },
    }),
    createSenderTool(tool, {
      name: "delete_meal",
      description: "Delete one existing meal by ID.",
      parameters: Type.Object({ id: Id }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/meals/${params.id}`, { method: "DELETE", sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_daily_nutrition",
      description: "Read database-backed meals and deterministic nutrition totals for a local calendar date.",
      parameters: Type.Object({ date: Type.String({ format: "date" }), timezone: Type.Optional(Type.String({ default: "Asia/Kuala_Lumpur" })) }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/nutrition/daily?date=${encodeURIComponent(params.date)}&timezone=${encodeURIComponent(params.timezone ?? "Asia/Kuala_Lumpur")}`, { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "save_food_preset",
      description: "Save or replace a user-confirmed repeated food preset.",
      parameters: Type.Object({ name: Type.String(), meal: PresetMeal }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, "/v1/food-presets", { method: "POST", body: params, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "find_food_preset",
      description: "Find a saved food preset before estimating repeated food.",
      parameters: Type.Object({ query: Type.String() }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/food-presets?query=${encodeURIComponent(params.query)}`, { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "update_food_preset",
      description: "Update fields on a saved food preset by ID.",
      parameters: Type.Object({
        id: Id,
        patch: Type.Partial(
          Type.Object({
            name: Type.String(),
            label: Type.String(),
            caloriesBest: Type.Integer({ minimum: 0 }),
            caloriesLow: Type.Integer({ minimum: 0 }),
            caloriesHigh: Type.Integer({ minimum: 0 }),
            proteinG: Type.Number({ minimum: 0 }),
            carbsG: Type.Number({ minimum: 0 }),
            fatG: Type.Number({ minimum: 0 }),
            fiberG: NullableNumber,
            confidence: Confidence,
            uncertaintyReasons: Type.Array(Type.String()),
          }),
        ),
      }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/food-presets/${params.id}`, { method: "PATCH", body: params.patch, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "delete_food_preset",
      description: "Delete a saved food preset by ID.",
      parameters: Type.Object({ id: Id }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/food-presets/${params.id}`, { method: "DELETE", sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "start_workout",
      description: "Start one active conversational workout session.",
      parameters: Type.Object({ name: Type.String(), startedAt: Type.Optional(Type.String({ format: "date-time" })), idempotencyKey: IdempotencyKey }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, "/v1/workouts", { method: "POST", body: params, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_active_workout",
      description: "Get the active workout and all current exercises and sets.",
      parameters: Type.Object({}),
      execute: (_params, { config, sender, signal }) =>
        healthFetch(config, "/v1/workouts/active", { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "add_workout_set",
      description: "Add one set to an exercise in the active workout. Repeated shorthand should reuse the latest exercise and weight from tool state.",
      parameters: Type.Object({
        workoutId: Id,
        exerciseName: Type.String(),
        weightKg: NullableNumber,
        reps: Type.Integer({ minimum: 1 }),
        rpe: Type.Optional(Type.Union([Type.Number({ minimum: 1, maximum: 10 }), Type.Null()])),
        notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        occurredAt: Type.Optional(Type.String({ format: "date-time" })),
        idempotencyKey: IdempotencyKey,
      }),
      execute: (params, { config, sender, signal }) => {
        const { workoutId, ...body } = params;
        return healthFetch(config, `/v1/workouts/${workoutId}/sets`, { method: "POST", body, sender, ...(signal ? { signal } : {}) });
      },
    }),
    createSenderTool(tool, {
      name: "update_workout_set",
      description: "Correct an existing workout set by ID.",
      parameters: Type.Object({
        id: Id,
        patch: Type.Partial(
          Type.Object({
            weightKg: NullableNumber,
            reps: Type.Integer({ minimum: 1 }),
            rpe: Type.Union([Type.Number({ minimum: 1, maximum: 10 }), Type.Null()]),
            notes: Type.Union([Type.String(), Type.Null()]),
          }),
        ),
      }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/workout-sets/${params.id}`, { method: "PATCH", body: params.patch, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "delete_workout_set",
      description: "Delete an existing workout set by ID.",
      parameters: Type.Object({ id: Id }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/workout-sets/${params.id}`, { method: "DELETE", sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "finish_workout",
      description: "Finish the active workout and return deterministic totals.",
      parameters: Type.Object({ id: Id, finishedAt: Type.Optional(Type.String({ format: "date-time" })) }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/workouts/${params.id}/finish`, { method: "POST", body: params.finishedAt ? { finishedAt: params.finishedAt } : {}, sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_previous_exercise_performance",
      description: "Get the most recent prior performance for an exercise.",
      parameters: Type.Object({ name: Type.String(), before: Type.Optional(Type.String({ format: "date-time" })) }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/exercises/previous?name=${encodeURIComponent(params.name)}${params.before ? `&before=${encodeURIComponent(params.before)}` : ""}`, { sender, ...(signal ? { signal } : {}) }),
    }),
    createSenderTool(tool, {
      name: "get_workout_history",
      description: "List recent workouts with exercises, sets, volume, and estimated 1RM values.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: (params, { config, sender, signal }) =>
        healthFetch(config, `/v1/workouts/history?limit=${params.limit ?? 20}`, { sender, ...(signal ? { signal } : {}) }),
    }),
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

      const now = new Date();
      const klDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);
      const klTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const klYesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(yesterday);
      const timeContext = `\nCurrent user local time (Asia/Kuala_Lumpur): ${klDate} ${klTime} (+08:00). Today is ${klDate}. Yesterday was ${klYesterday}.\n`;

      return { appendSystemContext: `${healthTrackingGuidance}\n${timeContext}` };
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
};

export default plugin;

const healthTrackingGuidance = `
ClawFit health tracking policy:
- The Health API/database is authoritative. Use the ClawFit tools for meal/workout state, and never claim a write succeeded unless its tool call succeeded.
- Treat clear workout phrases as actions without unnecessary clarification: "starting push" starts a Push workout; "bench 80 x 8" adds that set; "8 again" reuses the latest exercise and weight; "only got 6" adds another set unless explicitly called a correction. Resolve current state with get_active_workout when needed.
- Corrections update the existing meal or workout-set ID after resolving it from recent/active state. Never create a replacement. Reuse a stable idempotency key when retrying a create action.
- Perform only the action in the latest user message. Earlier unanswered or failed user messages are context, not queued actions: never replay them. A retry of the same current action must reuse its original idempotency key.
- ALL food and meal estimation (including food photos, restaurant meals, mixed dishes, and food descriptions) MUST use estimate_nutrition. The dedicated strong nutrition model (Gemini 3.8 Flash / 3.7 Flash) performs nutritional calculation; never guess or compute calories/macros mentally. Persist every unconfirmed estimate with create_pending_meal before presenting it to the user. Do not call log_meal until the user confirms, unless their first message explicitly asks to log/save/track it.
- When an image of a product and an image of its nutrition label are both available, inspect both; printed nutrition label values take precedence over visual estimation.
- On user confirmation ("log it", "log both", "yes", "save it"): DO NOT re-run estimate_nutrition. Confirm the relevant draft(s) with confirm_pending_meal. For a single draft, "log it" confirms that pending meal; for multiple items, "log both" confirms the active drafts.
- Updating unconfirmed drafts before confirmation: use update_pending_meal. Updating confirmed/logged meals: use update_meal with the confirmed meal ID (confirmedMealId). Never use a pending draft ID with update_meal.
- Date corrections ("that was yesterday", "move meals to yesterday", "I ate this last night"): Use the local calendar date for yesterday in Asia/Kuala_Lumpur. If meals were already logged today, update their occurredAt via update_meal to yesterday's date. If confirming a pending draft from yesterday, pass occurredAt with yesterday's timestamp to confirm_pending_meal.
- For "What did I eat today?" or calorie totals, make a single call to get_daily_nutrition with today's local date and return a direct, concise summary.
- Use deterministic volume and estimated 1RM returned by the tools. Nutrition is an estimate, not medical advice.
`;
