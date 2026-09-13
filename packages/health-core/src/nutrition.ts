import { nutritionEstimateSchema, type NutritionEstimate } from "./schemas.js";

export type NutritionErrorCode =
  | "CREDENTIALS_OR_CONFIG"
  | "QUOTA_OR_RATE_LIMIT"
  | "TIMEOUT_OR_CANCELLED"
  | "MODEL_OUTPUT_BLOCKED"
  | "MODEL_OUTPUT_INVALID"
  | "PROVIDER_TRANSIENT"
  | "PERSISTENCE_FAILURE";

export type NutritionModelUsage = {
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
};

export type NutritionModelRequest = {
  model: string;
  prompt: string;
  image?: { mimeType: string; base64: string };
  images?: { mimeType: string; base64: string }[];
  signal?: AbortSignal;
};

export interface NutritionModelClient {
  generate(request: NutritionModelRequest): Promise<unknown>;
}

export class NutritionEstimationError extends Error {
  readonly code: NutritionErrorCode;
  readonly statusCode: number;
  readonly attempts: readonly {
    model: string;
    reason: string;
    code: NutritionErrorCode;
    latencyMs?: number;
  }[];

  constructor(
    message: string,
    attempts: readonly { model: string; reason: string; code?: NutritionErrorCode; latencyMs?: number }[] = [],
    code?: NutritionErrorCode,
    statusCode?: number,
  ) {
    super(message);
    this.name = "NutritionEstimationError";
    const lastAttempt = attempts[attempts.length - 1];
    this.code = code ?? lastAttempt?.code ?? classifyNutritionErrorCode(message);
    this.statusCode = statusCode ?? getStatusCodeForNutritionError(this.code);
    this.attempts = attempts.map((a) => ({
      model: a.model,
      reason: a.reason,
      code: a.code ?? classifyNutritionErrorCode(a.reason),
      ...(a.latencyMs !== undefined ? { latencyMs: a.latencyMs } : {}),
    }));
  }
}

export function classifyNutritionErrorCode(errorOrMessage: unknown): NutritionErrorCode {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
  const name = errorOrMessage instanceof Error ? errorOrMessage.name : "";

  if (name === "AbortError" || /aborted|timeout|deadline exceeded/i.test(message)) {
    return "TIMEOUT_OR_CANCELLED";
  }
  if (/API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\b403\b/i.test(message)) {
    return "CREDENTIALS_OR_CONFIG";
  }
  if (/RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|\b429\b|rate limit/i.test(message)) {
    return "QUOTA_OR_RATE_LIMIT";
  }
  if (/blocked|SAFETY|PROMPT_BLOCKED|promptFeedback/i.test(message)) {
    return "MODEL_OUTPUT_BLOCKED";
  }
  if (/returned no JSON text|JSON|ZodError|validation failed|INVALID_ARGUMENT|\b400\b/i.test(message)) {
    return "MODEL_OUTPUT_INVALID";
  }
  if (/UNAVAILABLE|\b500\b|\b502\b|\b503\b|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return "PROVIDER_TRANSIENT";
  }
  if (/database|postgres|drizzle|sql/i.test(message)) {
    return "PERSISTENCE_FAILURE";
  }
  return "PROVIDER_TRANSIENT";
}

export function getStatusCodeForNutritionError(code: NutritionErrorCode): number {
  switch (code) {
    case "CREDENTIALS_OR_CONFIG":
      return 503;
    case "QUOTA_OR_RATE_LIMIT":
      return 429;
    case "TIMEOUT_OR_CANCELLED":
      return 504;
    case "MODEL_OUTPUT_BLOCKED":
      return 422;
    case "MODEL_OUTPUT_INVALID":
      return 502;
    case "PROVIDER_TRANSIENT":
      return 503;
    case "PERSISTENCE_FAILURE":
      return 500;
    default:
      return 500;
  }
}

export function getActionableMessageForNutritionError(code: NutritionErrorCode): string {
  switch (code) {
    case "CREDENTIALS_OR_CONFIG":
      return "Nutrition estimation service is temporarily misconfigured. Please use manual entry or try again later.";
    case "QUOTA_OR_RATE_LIMIT":
      return "AI usage rate limit reached. Please wait a minute or use manual entry.";
    case "TIMEOUT_OR_CANCELLED":
      return "Nutrition estimation timed out. Please try again or use manual entry.";
    case "MODEL_OUTPUT_BLOCKED":
      return "The meal description could not be processed due to content safety filters. Please adjust the description or enter details manually.";
    case "MODEL_OUTPUT_INVALID":
      return "The AI service returned an unreadable response format. Please try again or use manual entry.";
    case "PROVIDER_TRANSIENT":
      return "AI service is temporarily unavailable. Please try again in a few moments or use manual entry.";
    case "PERSISTENCE_FAILURE":
      return "Could not record the meal estimate. Please try again.";
    default:
      return "Nutrition estimation failed. Please try again or use manual entry.";
  }
}

export function isRetryableNutritionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Shared quota exhaustion, bad client arguments, schema validation errors on request, or shared auth/credential failures
  if (/RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|\b429\b|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|INVALID_ARGUMENT|\b401\b|\b403\b|\b400\b/i.test(message)) {
    return false;
  }
  return true;
}

export class NutritionEstimator {
  constructor(
    private readonly client: NutritionModelClient,
    private readonly models: readonly string[],
  ) {
    if (models.length === 0) throw new Error("At least one nutrition model is required");
  }

  async estimate(input: {
    text: string;
    image?: { mimeType: string; base64: string };
    images?: { mimeType: string; base64: string }[];
    signal?: AbortSignal;
  }): Promise<{
    estimate: NutritionEstimate;
    model: string;
    fallbackUsed: boolean;
    usage?: NutritionModelUsage | undefined;
    attempts: readonly { model: string; reason: string; code: NutritionErrorCode; latencyMs?: number }[];
  }> {
    const attempts: { model: string; reason: string; code: NutritionErrorCode; latencyMs?: number }[] = [];
    const totalStart = performance.now();
    const totalBudgetMs = 50_000;

    if (input.signal?.aborted) {
      throw new NutritionEstimationError("Estimation aborted by caller", [], "TIMEOUT_OR_CANCELLED", 504);
    }

    for (const [index, model] of this.models.entries()) {
      const elapsedTotal = performance.now() - totalStart;
      const remainingTotal = totalBudgetMs - elapsedTotal;

      if (index > 0 && remainingTotal < 10_000) {
        throw new NutritionEstimationError(
          "Deadline budget exhausted before fallback model could run",
          attempts,
          "TIMEOUT_OR_CANCELLED",
          504,
        );
      }

      const attemptBudget = index === 0 ? Math.min(35_000, remainingTotal) : remainingTotal;
      const attemptStart = performance.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, attemptBudget));

      const abortHandler = () => controller.abort();
      if (input.signal) {
        input.signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        const rawResult = await this.client.generate({
          model,
          prompt: nutritionPrompt(input.text),
          ...(input.images && input.images.length > 0
            ? { images: input.images }
            : input.image
              ? { image: input.image }
              : {}),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        if (input.signal) {
          input.signal.removeEventListener("abort", abortHandler);
        }

        const raw =
          rawResult && typeof rawResult === "object" && "data" in rawResult
            ? (rawResult as { data: unknown }).data
            : rawResult;
        const usage =
          rawResult && typeof rawResult === "object" && "usage" in rawResult
            ? (rawResult as { usage?: NutritionModelUsage }).usage
            : undefined;

        const estimate = nutritionEstimateSchema.parse(normalizeNutritionKeys(raw));
        return {
          estimate,
          model,
          fallbackUsed: index > 0,
          ...(usage !== undefined ? { usage } : {}),
          attempts,
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (input.signal) {
          input.signal.removeEventListener("abort", abortHandler);
        }

        const latencyMs = Math.round(performance.now() - attemptStart);
        const reason = error instanceof Error ? error.message : "Unknown model error";
        const code = classifyNutritionErrorCode(error);
        attempts.push({ model, reason, code, latencyMs });

        if (input.signal?.aborted) {
          throw new NutritionEstimationError("Estimation aborted by caller", attempts, "TIMEOUT_OR_CANCELLED", 504);
        }

        // Non-retryable errors (invalid credentials or malformed client payload) abort immediately
        if (!isRetryableNutritionError(error)) {
          throw new NutritionEstimationError(`Non-retryable model failure on ${model}: ${reason}`, attempts, code);
        }
      }
    }
    throw new NutritionEstimationError("All configured nutrition models failed", attempts);
  }
}

export function nutritionPrompt(userText: string): string {
  return [
    "Estimate the consumed meal's nutrition. Return JSON only.",
    "Use realistic ranges; never imply false precision. Hidden oils, sauces, and restaurant portions lower confidence.",
    "Provide item-level calories and macros where possible for each item in items[].",
    "Required keys: label, items[{name, portion_description, calories?, protein_g?, carbs_g?, fat_g?, fiber_g?}], calories{best,low,high},",
    "macros{protein_g,carbs_g,fat_g,fiber_g}, confidence(high|medium|low), uncertainty_reasons[].",
    `User description: ${userText || "No text supplied; infer from the attached meal image."}`,
  ].join("\n");
}

function normalizeNutritionKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => {
        const row = item as Record<string, unknown>;
        const calories = typeof row.calories === "number" ? row.calories : undefined;
        const proteinG = typeof row.proteinG === "number" ? row.proteinG : typeof row.protein_g === "number" ? row.protein_g : undefined;
        const carbsG = typeof row.carbsG === "number" ? row.carbsG : typeof row.carbs_g === "number" ? row.carbs_g : undefined;
        const fatG = typeof row.fatG === "number" ? row.fatG : typeof row.fat_g === "number" ? row.fat_g : undefined;
        const fiberG = typeof row.fiberG === "number" ? row.fiberG : typeof row.fiber_g === "number" ? row.fiber_g : row.fiberG === null || row.fiber_g === null ? null : undefined;
        return {
          name: row.name,
          portionDescription: row.portionDescription ?? row.portion_description,
          ...(calories !== undefined ? { calories } : {}),
          ...(proteinG !== undefined ? { proteinG } : {}),
          ...(carbsG !== undefined ? { carbsG } : {}),
          ...(fatG !== undefined ? { fatG } : {}),
          ...(fiberG !== undefined ? { fiberG } : {}),
        };
      })
    : raw.items;
  const macros = (raw.macros ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    items,
    macros: {
      proteinG: macros.proteinG ?? macros.protein_g,
      carbsG: macros.carbsG ?? macros.carbs_g,
      fatG: macros.fatG ?? macros.fat_g,
      fiberG: macros.fiberG ?? macros.fiber_g ?? null,
    },
    uncertaintyReasons: raw.uncertaintyReasons ?? raw.uncertainty_reasons,
  };
}

