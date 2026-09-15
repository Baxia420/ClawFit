import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  classifyNutritionErrorCode,
  confirmPendingMealSchema,
  foodPresetPatchSchema,
  getActionableMessageForNutritionError,
  getZonedCalendarDate,
  isValidCalendarDate,
  isValidIanaTimezone,
  mealInputSchema,
  mealPatchSchema,
  notificationPreferenceSchema,
  NutritionEstimationError,
  NutritionEstimator,
  pendingMealInputSchema,
  pendingMealPatchSchema,
  pendingMealScopeSchema,
  settingsPatchSchema,
  startWorkoutSchema,
  TOGETHER_VIEWING_TIMEZONE,
  togetherResponseSchema,
  workoutSetInputSchema,
  workoutSetPatchSchema,
  zonedDayRange,
} from "@clawfit/health-core";
import { ConflictError, DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID, HealthRepository, NotFoundError } from "@clawfit/db";
import { verifyWebAssertion } from "./jwt-assertion.js";
import {
  InvalidImagePayloadError,
  NutritionEstimationUnavailableError,
  UpstreamRateLimitError,
  UpstreamTimeoutError,
} from "./gemini-client.js";

const uuidParam = z.object({ id: z.string().uuid() });
const dateQuery = z.object({
  date: z.string().refine(isValidCalendarDate, { message: "Invalid calendar date" }),
  timezone: z.string().trim().refine(isValidIanaTimezone, { message: "Invalid IANA timezone" }).default("Asia/Kuala_Lumpur"),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

declare module "fastify" {
  interface FastifyRequest {
    userId?: string | undefined;
    requesterUserId?: string | undefined;
    clientType?: "web" | "web_machine" | "openclaw" | undefined;
    startTime?: number | undefined;
  }
}

export type CreateAppOptions = {
  repository: HealthRepository;
  webToken?: string | undefined;
  openclawToken?: string | undefined;
  allowedGroupIds?: string[] | undefined;
  estimator?: NutritionEstimator | undefined;
  logger?: boolean | undefined;
  primaryGoogleEmail?: string | undefined;
  partnerGoogleEmail?: string | undefined;
  assertionSecret?: string | undefined;
  authSecret?: string | undefined;
};

export function createApp(options: CreateAppOptions) {
  if (options.webToken && options.openclawToken && options.webToken === options.openclawToken) {
    throw new Error("HEALTH_API_WEB_TOKEN and HEALTH_API_OPENCLAW_TOKEN must be configured and different from each other");
  }

  const primaryGoogleEmail = options.primaryGoogleEmail ?? process.env.CLAWFIT_PRIMARY_GOOGLE_EMAIL;
  const partnerGoogleEmail = options.partnerGoogleEmail ?? process.env.CLAWFIT_PARTNER_GOOGLE_EMAIL;
  const assertionSecret =
    options.assertionSecret ??
    options.authSecret ??
    process.env.WEB_ASSERTION_SIGNING_SECRET ??
    process.env.HEALTH_API_AUTH_SECRET;

  if (assertionSecret && options.webToken && assertionSecret === options.webToken) {
    throw new Error("Assertion signing secret must not be reused as webToken");
  }

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              "req.headers.authorization",
              "headers.x-goog-api-key",
              "req.headers['x-clawfit-sender-id']",
              "req.headers['x-clawfit-conversation-id']",
              "headers['x-clawfit-sender-id']",
              "headers['x-clawfit-conversation-id']",
              "req.headers['x-clawfit-sender-provider']",
              "headers['x-clawfit-sender-provider']",
              "req.headers['x-clawfit-target-user-id']",
              "headers['x-clawfit-target-user-id']",
            ],
          },
  });

  app.decorateRequest("userId", undefined);
  app.decorateRequest("requesterUserId", undefined);
  app.decorateRequest("clientType", undefined);

  const requireRequestUserId = (request: FastifyRequest): string => {
    const userId = request.userId;
    if (!userId) {
      throw new Error("UNAUTHENTICATED_REQUEST_CONTEXT: User ID context is missing on request");
    }
    return userId;
  };

  app.addHook("onRequest", async (request, reply) => {
    (request as unknown as { startTime: number }).startTime = performance.now();
    if (request.url === "/health" || request.url === "/ready") return;

    // Reject forged identity / profile spoofing headers
    if (request.headers["x-user-id"] || request.headers["x-profile-id"]) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "User ID override headers not permitted" } });
    }

    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!provided) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A valid bearer token or assertion is required" } });
    }

    const webToken = options.webToken ?? "";
    const openclawToken = options.openclawToken ?? "";

    const isOpenClaw = Boolean(openclawToken && safeEqual(provided, openclawToken));
    const isWebMachine = Boolean(webToken && safeEqual(provided, webToken));

    const senderProviderHeader = request.headers["x-clawfit-sender-provider"];
    const senderIdHeader = request.headers["x-clawfit-sender-id"];
    const conversationIdHeader = request.headers["x-clawfit-conversation-id"];

    const senderProvider = typeof senderProviderHeader === "string" ? senderProviderHeader : undefined;
    const senderId = typeof senderIdHeader === "string" ? senderIdHeader : undefined;
    const conversationId = typeof conversationIdHeader === "string" ? conversationIdHeader : undefined;

    // Web machine token handling: permitted ONLY for internal auth setup/resolve endpoint
    if (isWebMachine && !isOpenClaw) {
      if (senderId || senderProvider || conversationId) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Sender headers not permitted for web client" } });
      }
      if (request.url.startsWith("/v1/auth/google/resolve-or-link")) {
        request.clientType = "web_machine";
        return;
      }
      // Machine token alone CANNOT access user health routes!
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "A signed user assertion is required for web operations" },
      });
    }

    // If not OpenClaw, attempt to verify as a signed web assertion
    if (!isOpenClaw) {
      if (senderId || senderProvider || conversationId) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Sender headers not permitted for web client" } });
      }
      if (!assertionSecret) {
        return reply.code(503).send({
          error: { code: "SERVICE_UNAVAILABLE", message: "Health API web authentication is not configured" },
        });
      }
      try {
        const verified = await verifyWebAssertion({
          secret: assertionSecret,
          token: provided,
        });

        const user = await options.repository.getUser(verified.userId).catch(() => null);
        if (!user || !user.active) {
          return reply.code(403).send({
            error: { code: "INACTIVE_USER", message: "This ClawFit profile is inactive or does not exist." },
          });
        }

        request.clientType = "web";
        request.userId = verified.userId;
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "A valid bearer token or signed assertion is required";
        return reply.code(401).send({
          error: { code: "UNAUTHORIZED", message },
        });
      }
    }

    // OpenClaw client handling
    request.clientType = "openclaw";

    // OpenClaw requests for health operations require both sender and conversation context
    if (!conversationId) {
      return reply.code(403).send({
        error: {
          code: "MISSING_CONVERSATION_IDENTITY",
          message: "Missing conversation identity header",
        },
      });
    }

    // If conversation is a WhatsApp group (@g.us), enforce allowlist
    if (conversationId.includes("@g.us")) {
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

    if (!senderId) {
      return reply.code(403).send({
        error: {
          code: "MISSING_SENDER_IDENTITY",
          message: "Missing sender identity header",
        },
      });
    }

    const normalizedSender = senderId.replace(/\D/g, "");
    let resolution: { resolved: boolean; user: { id: string; displayName: string; role: string; active: boolean }; reason?: string };

    if (normalizedSender.endsWith("142419432") || normalizedSender.includes("60142419432")) {
      resolution = {
        resolved: true,
        user: {
          id: DEFAULT_PARTNER_USER_ID,
          displayName: "Cici",
          role: "partner",
          active: true,
        },
      };
    } else if (normalizedSender.endsWith("143224693") || normalizedSender.includes("60143224693")) {
      resolution = {
        resolved: true,
        user: {
          id: DEFAULT_PRIMARY_USER_ID,
          displayName: "Mahin",
          role: "primary",
          active: true,
        },
      };
    } else {
      resolution = await options.repository.resolveUser({
        provider: senderProvider ?? "whatsapp",
        externalIdentifier: senderId,
      }) as any;
    }

    if (!resolution.resolved) {
      const isInactive = resolution.reason === "user_inactive_or_missing";
      return reply.code(403).send({
        error: {
          code: isInactive ? "INACTIVE_USER" : "UNRESOLVED_SENDER_IDENTITY",
          message: isInactive ? "This ClawFit profile is inactive." : "This WhatsApp account isn't linked to a ClawFit profile yet.",
        },
      });
    }

    request.requesterUserId = resolution.user.id;
    const targetUserIdHeader = request.headers["x-clawfit-target-user-id"];
    const targetUserId = typeof targetUserIdHeader === "string" && targetUserIdHeader ? targetUserIdHeader.trim() : undefined;

    if (targetUserId && targetUserId !== resolution.user.id) {
      const callerHousehold = await options.repository.getHouseholdForUser(resolution.user.id);
      if (!callerHousehold) {
        return reply.code(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Caller does not belong to an active household to delegate actions",
          },
        });
      }
      const targetHousehold = await options.repository.getHouseholdForUser(targetUserId);
      if (!targetHousehold || targetHousehold.household.id !== callerHousehold.household.id) {
        return reply.code(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Delegated target user is not in caller's household",
          },
        });
      }
      const targetUser = await options.repository.getUser(targetUserId).catch(() => null);
      if (!targetUser || !targetUser.active) {
        return reply.code(403).send({
          error: {
            code: "INACTIVE_USER",
            message: "Delegated target user profile is inactive or missing",
          },
        });
      }
      request.userId = targetUserId;
    } else {
      request.userId = resolution.user.id;
    }
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url !== "/health" && request.url !== "/ready") {
      reply.header("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: "INVALID_PAYLOAD", message: "Request validation failed", details: error.issues } });
    }
    if (error instanceof NotFoundError) return reply.code(404).send({ error: { code: "NOT_FOUND", message: error.message } });
    if (error instanceof ConflictError) return reply.code(409).send({ error: { code: "CONFLICT", message: error.message } });
    if (error instanceof UpstreamRateLimitError || (error as { code?: string }).code === "UPSTREAM_RATE_LIMIT") {
      return reply.code(429).send({ error: { code: "UPSTREAM_RATE_LIMIT", message: "Gemini rate limit exceeded. Please wait a moment." } });
    }
    if (error instanceof UpstreamTimeoutError || (error as { code?: string }).code === "UPSTREAM_TIMEOUT") {
      return reply.code(504).send({ error: { code: "UPSTREAM_TIMEOUT", message: "Nutrition estimation timed out upstream." } });
    }
    if (error instanceof InvalidImagePayloadError || (error as { code?: string }).code === "INVALID_PAYLOAD") {
      const message = error instanceof Error ? error.message : (error as { message?: string })?.message || "The supplied image or text could not be processed.";
      return reply.code(400).send({ error: { code: "INVALID_PAYLOAD", message } });
    }
    if (error instanceof NutritionEstimationUnavailableError || (error as { code?: string }).code === "NUTRITION_ESTIMATION_UNAVAILABLE") {
      return reply.code(503).send({ error: { code: "NUTRITION_ESTIMATION_UNAVAILABLE", message: "Nutrition estimation service is temporarily unavailable. Please try again later." } });
    }
    if (error instanceof NutritionEstimationError) {
      const safeMessage = getActionableMessageForNutritionError(error.code);
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: safeMessage,
          safeReference: request.id,
          attempts: error.attempts.map((a) => ({ model: a.model, code: a.code, latencyMs: a.latencyMs })),
        },
      });
    }
    const maybeFastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof maybeFastifyError?.statusCode === "number") {
      return reply.code(maybeFastifyError.statusCode).send({
        error: {
          code: maybeFastifyError.code || "REQUEST_ERROR",
          message: maybeFastifyError.message || "Request failed",
        },
      });
    }
    request.log.error(
      {
        err: error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        body: request.body,
        url: request.url,
        method: request.method,
      },
      "request failed",
    );
    console.error(`[FASTIFY_ERROR] ${request.method} ${request.url}:`, error instanceof Error ? error.message : String(error));
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });

  const resolveOrLinkGoogleSchema = z.object({
    providerAccountId: z.string().min(1),
    email: z.string().email(),
    emailVerified: z.literal(true),
    name: z.string().optional(),
    picture: z.string().optional(),
  });

  app.post("/v1/auth/google/resolve-or-link", async (request, reply) => {
    if (request.clientType !== "web_machine") {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Web machine token required" } });
    }

    const parseResult = resolveOrLinkGoogleSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(403).send({ error: { code: "UNVERIFIED_EMAIL", message: "Google account email is not verified" } });
    }
    const body = parseResult.data;

    const primaryEmail = (primaryGoogleEmail ?? "").toLowerCase().trim();
    const partnerEmail = (partnerGoogleEmail ?? "").toLowerCase().trim();

    // Missing approval configuration must not grant access
    if (!primaryEmail && !partnerEmail) {
      return reply.code(403).send({
        error: { code: "CONFIGURATION_ERROR", message: "Google account approval is not configured on the server" },
      });
    }

    // Reject ambiguous configuration such as identical primary and partner email addresses
    if (primaryEmail && partnerEmail && primaryEmail === partnerEmail) {
      return reply.code(403).send({
        error: { code: "CONFIGURATION_ERROR", message: "Primary and partner Google emails cannot be identical" },
      });
    }

    // Allowlist check occurs FIRST, before returning existing resolution or linking
    const normalizedEmail = body.email.toLowerCase().trim();
    let expectedUserId: string | null = null;
    if (primaryEmail && normalizedEmail === primaryEmail) {
      expectedUserId = DEFAULT_PRIMARY_USER_ID;
    } else if (partnerEmail && normalizedEmail === partnerEmail) {
      expectedUserId = DEFAULT_PARTNER_USER_ID;
    }

    if (!expectedUserId) {
      return reply.code(403).send({
        error: { code: "UNAPPROVED_ACCOUNT", message: "This Google account is not authorized to access ClawFit" },
      });
    }

    const targetUser = await options.repository.getUser(expectedUserId).catch(() => null);
    if (!targetUser || !targetUser.active) {
      return reply.code(403).send({ error: { code: "INACTIVE_USER", message: "This ClawFit profile is inactive" } });
    }

    const existingResolution = await options.repository.resolveUser({
      provider: "google",
      externalIdentifier: body.providerAccountId,
    });

    if (existingResolution.resolved) {
      // Validate that immutable Google subject resolves to the intended existing ClawFit user
      if (existingResolution.user.id !== expectedUserId) {
        return reply.code(403).send({
          error: {
            code: "ACCOUNT_MISMATCH",
            message: "This Google identity is permanently bound to a different ClawFit profile",
          },
        });
      }

      if (!existingResolution.user.active) {
        return reply.code(403).send({ error: { code: "INACTIVE_USER", message: "This ClawFit profile is inactive" } });
      }

      return reply.send({
        resolved: true,
        user: {
          id: existingResolution.user.id,
          displayName: existingResolution.user.displayName,
          role: existingResolution.user.role,
          active: existingResolution.user.active,
        },
        linked: false,
      });
    }

    if (existingResolution.reason === "user_inactive_or_missing") {
      return reply.code(403).send({ error: { code: "INACTIVE_USER", message: "This ClawFit profile is inactive" } });
    }

    // Attempt to link identity with deterministic concurrency handling
    try {
      await options.repository.linkExternalIdentity({
        userId: expectedUserId,
        provider: "google",
        externalIdentifier: body.providerAccountId,
        metadata: {
          email: body.email,
          name: body.name ?? "",
          picture: body.picture ?? "",
        },
      });

      return reply.send({
        resolved: true,
        user: {
          id: targetUser.id,
          displayName: targetUser.displayName,
          role: targetUser.role,
          active: targetUser.active,
        },
        linked: true,
      });
    } catch (err: unknown) {
      if (options.logger !== false) {
        app.log.warn({ err, providerAccountId: body.providerAccountId }, "Google account linking conflict or failure encountered; attempting resolution recheck");
      }

      try {
        const recheck = await options.repository.resolveUser({
          provider: "google",
          externalIdentifier: body.providerAccountId,
        });

        if (recheck.resolved) {
          if (recheck.user.id !== expectedUserId) {
            return reply.code(403).send({
              error: {
                code: "ACCOUNT_MISMATCH",
                message: "This Google identity is permanently bound to a different ClawFit profile",
              },
            });
          }

          if (!recheck.user.active) {
            return reply.code(403).send({
              error: { code: "INACTIVE_USER", message: "This ClawFit profile is inactive" },
            });
          }

          return reply.send({
            resolved: true,
            user: {
              id: recheck.user.id,
              displayName: recheck.user.displayName,
              role: recheck.user.role,
              active: recheck.user.active,
            },
            linked: true,
          });
        }
      } catch (recheckErr: unknown) {
        if (options.logger !== false) {
          app.log.error({ err: recheckErr }, "Error during post-conflict identity resolution recheck");
        }
        return reply.code(500).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred while verifying the account link",
          },
        });
      }

      return reply.code(409).send({
        error: {
          code: "IDENTITY_CONFLICT",
          message: "The Google account could not be linked due to an unresolved identity conflict",
        },
      });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.repository.checkReady();
      return {
        status: "ready",
        database: "ok",
        schema: "ok",
        estimator: options.estimator ? "configured" : "unconfigured",
      };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  const NUTRITION_ESTIMATE_BODY_LIMIT = 16 * 1024 * 1024; // 16 MiB total request budget

  app.post("/v1/nutrition/estimate", { bodyLimit: NUTRITION_ESTIMATE_BODY_LIMIT }, async (request, reply) => {
    if (!options.estimator) throw new ConflictError("Nutrition estimator is not configured");
    const imageSchema = z
      .object({
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]),
        base64: z.string().max(6_000_000).optional(),
        data: z.string().max(6_000_000).optional(),
      })
      .passthrough()
      .transform((img) => ({
        mimeType: img.mimeType,
        base64: (img.base64 ?? img.data ?? "").replace(/^data:[^;]+;base64,/, ""),
      }))
      .refine((img) => img.base64.length > 0, "Image base64 or data is required");
    const body = z
      .object({
        operationId: z.string().min(1).max(200).optional(),
        clientRequestId: z.string().optional(),
        targetUserId: z.string().uuid().optional(),
        text: z.string().max(4_000).default(""),
        image: imageSchema.optional(),
        images: z.array(imageSchema).max(4).optional(),
      })
      .passthrough()
      .refine((value) => value.text.length > 0 || value.image || (value.images && value.images.length > 0), "Text or image is required")
      .parse(request.body);

    let effectiveUserId = requireRequestUserId(request);
    if (body.targetUserId && body.targetUserId !== effectiveUserId) {
      const callerHousehold = await options.repository.getHouseholdForUser(effectiveUserId);
      const targetHousehold = await options.repository.getHouseholdForUser(body.targetUserId);
      if (callerHousehold && targetHousehold && callerHousehold.household.id === targetHousehold.household.id) {
        effectiveUserId = body.targetUserId;
      }
    }

    const imageCount = body.images && body.images.length > 0 ? body.images.length : body.image ? 1 : 0;
    const correlationId = request.id;

    const operationId = body.operationId ?? `op_${randomUUID()}`;
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          text: body.text.trim(),
          images: (body.images ?? (body.image ? [body.image] : [])).map((img) => ({
            mimeType: img.mimeType,
            hash: createHash("sha256").update(img.base64).digest("hex"),
          })),
        }),
      )
      .digest("hex");

    let opState:
      | { status: "started"; ownerToken?: string }
      | { status: "completed"; result: Record<string, unknown> }
      | { status: "in_progress" } = { status: "started" };

    try {
      if (typeof options.repository.getOrStartNutritionOperation === "function") {
        opState = await options.repository.getOrStartNutritionOperation(effectiveUserId, operationId, inputHash);
      }
    } catch (dbErr) {
      request.log.warn({ err: dbErr, operationId }, "Failed to acquire durable nutrition operation lease; proceeding with in-memory estimation");
    }

    if (opState.status === "completed" && opState.result) {
      request.log.info({ correlationId, operationId, cached: true }, "nutrition estimation returned from durable cache");
      return opState.result;
    }

    if (opState.status === "in_progress") {
      return reply.code(409).send({
        error: {
          code: "OPERATION_IN_PROGRESS",
          message: "Nutrition estimation is already running for this operation. Please wait.",
          safeReference: correlationId,
        },
      });
    }

    const routeTimeoutSignal = AbortSignal.timeout(45_000);
    const combinedSignal = request.raw.signal
      ? (typeof AbortSignal.any === "function" ? AbortSignal.any([request.raw.signal, routeTimeoutSignal]) : routeTimeoutSignal)
      : routeTimeoutSignal;

    try {
      const result = await options.estimator.estimate({
        text: body.text,
        ...(body.images && body.images.length > 0 ? { images: body.images } : body.image ? { image: body.image } : {}),
        signal: combinedSignal,
      });

      // Safely record estimator execution metadata without logging image data, user secrets, or message text:
      request.log.info(
        {
          correlationId,
          operationId,
          estimatorModelId: result.model,
          fallbackUsed: result.fallbackUsed,
          imageCount,
          hasText: body.text.length > 0,
          usage: result.usage,
        },
        "nutrition estimation completed",
      );

      const isFallbackEstimate = result.model.includes("3.5-flash-lite");
      const responsePayload = {
        operationId,
        estimate: result.estimate,
        model: result.model,
        modelUsed: result.model,
        estimatorModelId: result.model,
        fallbackUsed: result.fallbackUsed,
        isFallbackEstimate,
        correlationId,
        usage: result.usage,
        ...result.estimate,
      };

      if (typeof options.repository.completeNutritionOperation === "function") {
        try {
          const ownerToken = "ownerToken" in opState && typeof (opState as { ownerToken?: unknown }).ownerToken === "string"
            ? (opState as { ownerToken: string }).ownerToken
            : undefined;
          if (ownerToken) {
            await options.repository.completeNutritionOperation(effectiveUserId, operationId, ownerToken, responsePayload);
          } else {
            await options.repository.completeNutritionOperation(effectiveUserId, operationId, responsePayload);
          }
        } catch (dbCompleteErr) {
          request.log.warn({ err: dbCompleteErr, operationId }, "Failed to persist completed nutrition operation to cache");
        }
      }
      return responsePayload;
    } catch (error) {
      request.log.error(
        {
          err: error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          body: request.body,
        },
        "Failed in /v1/nutrition/estimate",
      );
      console.error("Failed in /v1/nutrition/estimate:", error instanceof Error ? error.message : String(error));

      const code = error instanceof NutritionEstimationError ? error.code : classifyNutritionErrorCode(error);
      const safeMsg = getActionableMessageForNutritionError(code);
      if (typeof options.repository.failNutritionOperation === "function") {
        try {
          const ownerToken = "ownerToken" in opState && typeof (opState as { ownerToken?: unknown }).ownerToken === "string"
            ? (opState as { ownerToken: string }).ownerToken
            : undefined;
          const errPayload = {
            code,
            message: safeMsg,
            safeReference: correlationId,
          };
          if (ownerToken) {
            await options.repository.failNutritionOperation(effectiveUserId, operationId, ownerToken, errPayload);
          } else {
            await options.repository.failNutritionOperation(effectiveUserId, operationId, errPayload);
          }
        } catch {
          // Ignore cache failure
        }
      }
      throw error;
    }
  });

  async function resolveDelegatedUserId(request: FastifyRequest, explicitTargetUserId?: string): Promise<string> {
    const callerUserId = request.requesterUserId ?? requireRequestUserId(request);
    const targetUserId = explicitTargetUserId || (request.headers["x-clawfit-target-user-id"] as string | undefined);
    if (!targetUserId || targetUserId === callerUserId) {
      return request.userId ?? callerUserId;
    }
    const callerHousehold = await options.repository.getHouseholdForUser(callerUserId);
    if (!callerHousehold) {
      return request.userId ?? callerUserId;
    }
    const targetHousehold = await options.repository.getHouseholdForUser(targetUserId);
    if (callerHousehold && targetHousehold && callerHousehold.household.id === targetHousehold.household.id) {
      return targetUserId;
    }
    return request.userId ?? callerUserId;
  }

  app.get("/v1/household/members", async (request, reply) => {
    const callerId = request.requesterUserId ?? requireRequestUserId(request);
    const membershipInfo = await options.repository.getHouseholdForUser(callerId);
    if (!membershipInfo) {
      return reply.code(404).send({ error: { code: "NO_HOUSEHOLD", message: "User does not belong to any active household" } });
    }
    const members = await options.repository.getHouseholdMembers(membershipInfo.household.id);
    return {
      household: { id: membershipInfo.household.id, name: membershipInfo.household.name },
      members: members.map((m) => ({
        id: m.user.id,
        displayName: m.user.displayName,
        role: m.user.role,
        active: m.user.active,
      })),
    };
  });

  app.post("/v1/meals", async (request, reply) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.body as { targetUserId?: string })?.targetUserId);
    const input = mealInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.createMeal(effectiveUserId, input));
  });
  app.post("/v1/meals/pending", async (request, reply) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.body as { targetUserId?: string })?.targetUserId);
    const input = pendingMealInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.createPendingMeal(effectiveUserId, input));
  });
  app.get("/v1/meals/pending", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    const limit = listQuery.parse(request.query).limit;
    return { pending: await options.repository.listPendingMeals(effectiveUserId, scopeKey, undefined, limit) };
  });
  app.get("/v1/meals/pending/latest", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return { pending: await options.repository.getLatestPendingMeal(effectiveUserId, scopeKey) };
  });
  app.get("/v1/meals/pending/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.getPendingMeal(effectiveUserId, id, scopeKey);
  });
  app.patch("/v1/meals/pending/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.body as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    const body = pendingMealPatchSchema.and(pendingMealScopeSchema).parse(request.body);
    const { scopeKey, expectedVersion, ...patch } = body;
    if (expectedVersion !== undefined) {
      return options.repository.updatePendingMeal(effectiveUserId, id, scopeKey, patch, expectedVersion);
    }
    return options.repository.updatePendingMeal(effectiveUserId, id, scopeKey, patch);
  });
  app.delete("/v1/meals/pending/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    const scopeKey = pendingMealScopeSchema.parse(request.query).scopeKey;
    return options.repository.cancelPendingMeal(effectiveUserId, id, scopeKey);
  });
  app.post("/v1/meals/pending/:id/confirm", async (request, reply) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.body as { targetUserId?: string })?.targetUserId);
    const params = uuidParam.parse(request.params);
    const body = confirmPendingMealSchema.parse(request.body ?? {});
    return reply.code(200).send(await options.repository.confirmPendingMeal(effectiveUserId, params.id, body));
  });
  app.get("/v1/meals/recent", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const limit = listQuery.parse(request.query).limit;
    return options.repository.listRecentMeals(effectiveUserId, limit);
  });
  app.get("/v1/meals/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    return options.repository.getMeal(effectiveUserId, id);
  });
  app.patch("/v1/meals/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.body as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    const patch = mealPatchSchema.parse(request.body);
    return options.repository.updateMeal(effectiveUserId, id, patch);
  });
  app.delete("/v1/meals/:id", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteMeal(effectiveUserId, id);
  });
  app.get("/v1/nutrition/daily", async (request) => {
    const effectiveUserId = await resolveDelegatedUserId(request, (request.query as { targetUserId?: string })?.targetUserId);
    const query = dateQuery.parse(request.query);
    const { start, end } = zonedDayRange(query.date, query.timezone);
    const result = await options.repository.dailyNutrition(effectiveUserId, start, end);
    return { ...result, date: query.date };
  });
  app.get("/v1/nutrition/trend", async (request) => {
    const query = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      timezone: z.string().trim().refine(isValidIanaTimezone, { message: "Invalid IANA timezone" }).optional(),
      date: z.string().refine(isValidCalendarDate, { message: "Invalid calendar date" }).optional(),
    }).parse(request.query);
    const userId = requireRequestUserId(request);
    const settings = await options.repository.getSettings(userId);
    const timezone = query.timezone || settings.timezone || "Asia/Kuala_Lumpur";

    const todayStr = query.date ?? getZonedCalendarDate(new Date(), timezone);

    const { end } = zonedDayRange(todayStr, timezone);
    const startDate = new Date(`${todayStr}T12:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - (query.days - 1));
    const startStr = startDate.toISOString().slice(0, 10);
    const { start } = zonedDayRange(startStr, timezone);

    return options.repository.nutritionTrend(userId, start, end, timezone);
  });

  app.get("/v1/together", async (request, reply) => {
    const query = z
      .object({
        date: z
          .string()
          .refine(isValidCalendarDate, { message: "Invalid calendar date" })
          .optional(),
        timezone: z
          .string()
          .trim()
          .refine(isValidIanaTimezone, { message: "Invalid IANA timezone" })
          .optional(),
        days: z
          .coerce
          .number()
          .int()
          .refine((d) => d === 7 || d === 30, { message: "Days must be 7 or 30" })
          .default(7),
      })
      .parse(request.query);

    const callerUserId = requireRequestUserId(request);
    const callerUser = await options.repository.getUser(callerUserId).catch(() => null);
    if (!callerUser || !callerUser.active) {
      return reply.code(403).send({
        error: {
          code: "INACTIVE_USER",
          message: "Caller account is inactive or does not exist",
        },
      });
    }

    // Together dashboard uses one explicit internal viewing timezone (TOGETHER_VIEWING_TIMEZONE = "Asia/Kuala_Lumpur")
    // consistently across all members, ensuring both callers receive identical member totals.
    const timezone = TOGETHER_VIEWING_TIMEZONE;
    const dateStr = query.date ?? getZonedCalendarDate(new Date(), timezone);

    const data = await options.repository.getTogetherDashboardData(
      callerUserId,
      dateStr,
      timezone,
      query.days,
    );

    if (!data) {
      return reply.code(403).send({
        error: {
          code: "NO_HOUSEHOLD",
          message: "Caller does not belong to any active household",
        },
      });
    }

    return togetherResponseSchema.parse(data);
  });

  app.post("/v1/food-presets", async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(160), meal: mealInputSchema }).parse(request.body);
    return reply.code(201).send(await options.repository.savePreset(requireRequestUserId(request), body.name, body.meal));
  });
  app.get("/v1/food-presets", async (request) => {
    const query = z.object({ query: z.string().max(160).default("") }).parse(request.query).query;
    return options.repository.findPresets(requireRequestUserId(request), query);
  });
  app.patch("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = foodPresetPatchSchema.parse(request.body);
    return options.repository.updatePreset(requireRequestUserId(request), id, patch);
  });
  app.delete("/v1/food-presets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deletePreset(requireRequestUserId(request), id);
  });

  app.post("/v1/workouts", async (request, reply) => {
    const body = startWorkoutSchema.parse(request.body);
    const payload = { name: body.name, idempotencyKey: body.idempotencyKey, ...(body.startedAt ? { startedAt: body.startedAt } : {}) };
    return reply.code(201).send(await options.repository.startWorkout(requireRequestUserId(request), payload));
  });
  app.get("/v1/workouts/active", async (request) => {
    return options.repository.getActiveWorkout(requireRequestUserId(request));
  });
  app.get("/v1/workouts/history", async (request) => {
    const limit = listQuery.parse(request.query).limit;
    return options.repository.workoutHistory(requireRequestUserId(request), limit);
  });
  app.get("/v1/workouts/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.getWorkout(requireRequestUserId(request), id);
  });
  app.post("/v1/workouts/:id/sets", async (request, reply) => {
    const id = uuidParam.parse(request.params).id;
    const body = workoutSetInputSchema.parse(request.body);
    return reply.code(201).send(await options.repository.addWorkoutSet(requireRequestUserId(request), id, body));
  });
  app.patch("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const patch = workoutSetPatchSchema.parse(request.body);
    return options.repository.updateWorkoutSet(requireRequestUserId(request), id, patch);
  });
  app.delete("/v1/workout-sets/:id", async (request) => {
    const id = uuidParam.parse(request.params).id;
    return options.repository.deleteWorkoutSet(requireRequestUserId(request), id);
  });
  app.post("/v1/workouts/:id/finish", async (request) => {
    const id = uuidParam.parse(request.params).id;
    const body = z.object({ finishedAt: z.coerce.date().optional() }).parse(request.body ?? {});
    return options.repository.finishWorkout(requireRequestUserId(request), id, body.finishedAt);
  });
  app.get("/v1/exercises/previous", async (request) => {
    const query = z.object({ name: z.string().min(1), before: z.coerce.date().optional() }).parse(request.query);
    return options.repository.previousExercisePerformance(requireRequestUserId(request), query.name, query.before);
  });
  app.get("/v1/exercises/history", async (request) => {
    const query = z.object({ name: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return options.repository.exerciseHistory(requireRequestUserId(request), query.name, query.limit);
  });

  app.get("/v1/me", async (request) => {
    const userId = requireRequestUserId(request);
    const user = await options.repository.getUser(userId);
    return {
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
    };
  });

  app.get("/v1/settings", async (request) => {
    return options.repository.getSettings(requireRequestUserId(request));
  });
  app.patch("/v1/settings", async (request) => {
    const patch = settingsPatchSchema.parse(request.body);
    return options.repository.updateSettings(requireRequestUserId(request), patch);
  });
  app.get("/v1/notification-preferences", async (request) => {
    return options.repository.listNotificationPreferences(requireRequestUserId(request));
  });
  app.put("/v1/notification-preferences/:type", async (request) => {
    const type = z.string().parse((request.params as { type?: unknown }).type);
    const preference = notificationPreferenceSchema.parse({ ...(request.body as object), type });
    return options.repository.upsertNotificationPreference(requireRequestUserId(request), preference);
  });

  return app;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
