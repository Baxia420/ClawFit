import { nutritionEstimateSchema, type NutritionEstimate } from "./schemas.js";

export const NUTRITION_TOTAL_TIMEOUT_MS = 60_000;
export const NUTRITION_ATTEMPT_TIMEOUT_MS = 45_000;

export type NutritionModelRequest = {
  model: string;
  deadline?: number;
  prompt: string;
  image?: { mimeType: string; base64: string };
  images?: { mimeType: string; base64: string }[];
};

export interface NutritionModelClient {
  generate(request: NutritionModelRequest): Promise<unknown>;
}

export class NutritionEstimationError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly { model: string; reason: string }[],
  ) {
    super(message);
    this.name = "NutritionEstimationError";
  }

  // Never log raw provider messages: they may contain prompts or credentials.
  diagnostics() {
    return this.attempts.map(({ model, reason }) => ({
      model: /^[a-zA-Z0-9._/-]{1,100}$/.test(model) ? model : "invalid-model-id",
      category: /\b429\b|RESOURCE_EXHAUSTED/i.test(reason) ? "rate_limited"
        : /\b404\b|NOT_FOUND/i.test(reason) ? "model_not_found"
        : /\b401\b|\b403\b|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(reason) ? "authentication"
        : /\b400\b|INVALID_ARGUMENT/i.test(reason) ? "invalid_request"
        : /\b50[0-9]\b|UNAVAILABLE/i.test(reason) ? "provider_unavailable"
        : /timeout|timed out|aborted/i.test(reason) ? "timeout"
        : /blocked request/i.test(reason) ? "blocked"
        : /JSON|invalid_type|invalid_value|too_small|too_big/i.test(reason) ? "invalid_output"
        : "unknown",
    }));
  }
}

export function isRetryableNutritionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Unrecoverable errors: bad client arguments, schema validation errors on request, or shared auth/credential failures
  if (/API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|INVALID_ARGUMENT|\b401\b|\b403\b|\b400\b/i.test(message)) {
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
  }): Promise<{
    estimate: NutritionEstimate;
    model: string;
    fallbackUsed: boolean;
  }> {
    const attempts: { model: string; reason: string }[] = [];
    const deadline = Date.now() + NUTRITION_TOTAL_TIMEOUT_MS;
    for (const [index, model] of this.models.entries()) {
      if (Date.now() >= deadline) break;
      try {
        const raw = await this.client.generate({
          model,
          deadline,
          prompt: nutritionPrompt(input.text),
          ...(input.images && input.images.length > 0
            ? { images: input.images }
            : input.image
              ? { image: input.image }
              : {}),
        });
        return {
          estimate: nutritionEstimateSchema.parse(normalizeNutritionKeys(raw)),
          model,
          fallbackUsed: index > 0,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown model error";
        attempts.push({ model, reason });

        // Non-retryable errors (invalid credentials or malformed client payload) abort immediately
        if (!isRetryableNutritionError(error)) {
          throw new NutritionEstimationError(`Non-retryable model failure on ${model}: ${reason}`, attempts);
        }
      }
    }
    throw new NutritionEstimationError("All configured nutrition models failed", attempts);
  }
}

export function nutritionPrompt(userText: string): string {
  return [
    "Estimate the consumed meal's nutrition. Return JSON only.",
    "Several photos can show components or different views of one meal. Do not count the same food twice. User-stated amounts take priority over the number of food items pictured.",
    "Use only the current supplied photos and current user description. An assistant description is supplementary; do not include previous meals mentioned in it.",
    "Use realistic ranges; never imply false precision. Hidden oils, sauces, and restaurant portions lower confidence.",
    "No online lookup or food database tool is available. Do not claim to have searched or verified manufacturer data. Use printed label values only when legible in the supplied input. Treat unspecified packet weights and serving sizes as assumptions, lower confidence, and include those assumptions in uncertainty_reasons.",
    "Required keys: label, items[{name, portion_description}], calories{best,low,high},",
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
        return { name: row.name, portionDescription: row.portionDescription ?? row.portion_description };
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

