import {
  HealthApiError,
  healthFetch,
  type HealthPluginConfig,
  type SenderContext,
} from "./health-client.js";

export function isMealLogConfirmation(prompt: string | null | undefined): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  const action = "(?:log(?:ged|ging)?|sav(?:e|ed|ing)|track(?:ed|ing)?|record(?:ed|ing)?)";
  if (new RegExp(`\\b(?:do\\s+not|don't|dont|never|without)\\b[^.!?]{0,60}\\b${action}\\b`, "i").test(trimmed)) return false;
  if (new RegExp(`\\b${action}\\b[^.!?]{0,30}\\b(?:not|never)\\b`, "i").test(trimmed)) return false;
  if (new RegExp(`^(?:what|when|where|why|how(?:\\s+much)?|did\\s+i|have\\s+i)\\b[^.!?]*\\b${action}\\b[^.!?]*[?]?$`, "i").test(trimmed)) return false;
  if (/\b(log|save|track|record)\b/i.test(trimmed)) return true;
  return /^\s*(yes|yep|yeah|sure|ok(?:ay)?|confirm|do it|go ahead|please do)[\s.!]*$/i.test(trimmed);
}

export function isFallbackNotice(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  return (
    /^(?:↪️\s*)?Model Fallback/i.test(trimmed) ||
    /^(?:↪️\s*)?\[Fallback\]/i.test(trimmed) ||
    /^(?:↪️\s*)?Fallback:/i.test(trimmed) ||
    /^(?:↪️\s*)?(?:Model\s+)?Fallback:?\s*(?:selected\s+)?(?:google|gemini)/i.test(trimmed)
  );
}

export function sanitizeUserFacingError(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "I couldn't complete that just now. Nothing was changed — try again in a moment.";

  if (text.includes("UNRESOLVED_SENDER_IDENTITY:") || text.includes("This WhatsApp account isn't linked to a ClawFit profile yet.")) {
    return "This WhatsApp account isn't linked to a ClawFit profile yet.";
  }
  if (text.includes("INACTIVE_USER:") || text.includes("This ClawFit profile is inactive.")) {
    return "This ClawFit profile is inactive. Please contact the household administrator.";
  }
  if (text.includes("UNAUTHORIZED_GROUP:") || text.includes("This WhatsApp group is not authorized for ClawFit health tracking.")) {
    return "This WhatsApp group is not authorized for ClawFit health tracking.";
  }
  if (text.includes("MISSING_CONVERSATION_IDENTITY:") || text.includes("Missing WhatsApp conversation context")) {
    return "Missing WhatsApp conversation context. Request cannot be processed.";
  }

  const hasRawError =
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /Google Generative AI API error/i.test(text) ||
    /quota exceeded/i.test(text) ||
    /HTTP 429/i.test(text) ||
    /assistant turn failed/i.test(text) ||
    /FailoverError/i.test(text) ||
    /HealthApiNetworkError/i.test(text) ||
    /fetch failed/i.test(text) ||
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(text) ||
    /\[code=\w+\]/i.test(text) ||
    /generativelanguage\.googleapis\.com/i.test(text);

  if (hasRawError) {
    return "I couldn't complete that just now. Nothing was changed — try again in a moment.";
  }
  return text;
}

export type ConfirmMealDraftInput = {
  id: string;
  scopeKey: string;
  occurredAt?: string | undefined;
  idempotencyKey?: string | undefined;
  expectedVersion?: number | undefined;
};

export type ConfirmMealDraftOptions = {
  config: HealthPluginConfig;
  sender?: SenderContext | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export type ConfirmMealDraftResult = {
  success: boolean;
  status: "confirmed" | "already_confirmed";
  mealId: string;
  name?: string | undefined;
  calories?: number | undefined;
  message: string;
  meal: Record<string, unknown>;
};

export async function confirmMealDraft(
  input: ConfirmMealDraftInput,
  options: ConfirmMealDraftOptions,
): Promise<ConfirmMealDraftResult> {
  const confirmPath = `/v1/meals/pending/${input.id}/confirm`;
  const confirmBody = {
    scopeKey: input.scopeKey,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  };

  try {
    const res = (await healthFetch<Record<string, unknown>>(options.config, confirmPath, {
      method: "POST",
      body: confirmBody,
      sender: options.sender,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })) as Record<string, unknown>;

    const mealId = String(res.id ?? input.id);
    const name = typeof res.label === "string" ? res.label : undefined;
    const calories =
      typeof (res.calories as { best?: number })?.best === "number"
        ? (res.calories as { best?: number }).best
        : typeof res.caloriesBest === "number"
          ? (res.caloriesBest as number)
          : undefined;

    return {
      success: true,
      status: "confirmed",
      mealId,
      name,
      calories,
      message: "Meal successfully logged to your daily journal.",
      meal: res,
    };
  } catch (error) {
    const isNotFound =
      (error instanceof HealthApiError && (error.code === "NOT_FOUND" || error.message.includes("not found"))) ||
      (error as Error)?.message?.includes("NOT_FOUND") ||
      (error as Error)?.message?.includes("not found");

    if (!isNotFound) {
      throw error;
    }

    // Idempotent fallback lookup: query GET /v1/meals/recent to check whether that exact pendingMealId was already successfully logged
    try {
      const recentMeals = await healthFetch<Array<Record<string, unknown>>>(
        options.config,
        "/v1/meals/recent?limit=20",
        {
          method: "GET",
          sender: options.sender,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
        },
      );

      const expectedIdempotencyKey = `confirmed_${input.id}`;
      const matching = Array.isArray(recentMeals)
        ? recentMeals.find(
            (m) =>
              m.id === input.id ||
              m.idempotencyKey === expectedIdempotencyKey ||
              (typeof m.idempotencyKey === "string" && m.idempotencyKey.includes(input.id)),
          )
        : undefined;

      if (matching) {
        const mealId = String(matching.id ?? input.id);
        const name = typeof matching.label === "string" ? matching.label : undefined;
        const calories =
          typeof (matching.calories as { best?: number })?.best === "number"
            ? (matching.calories as { best?: number }).best
            : typeof matching.caloriesBest === "number"
              ? (matching.caloriesBest as number)
              : undefined;

        return {
          success: true,
          status: "already_confirmed",
          mealId,
          name,
          calories,
          message: "This meal has already been logged.",
          meal: matching,
        };
      }
    } catch {
      // Ignore fallback query failure and proceed to direct check
    }

    // Try direct GET /v1/meals/:id if input.id is already the canonical mealId
    try {
      const directMeal = await healthFetch<Record<string, unknown>>(
        options.config,
        `/v1/meals/${encodeURIComponent(input.id)}`,
        {
          method: "GET",
          sender: options.sender,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
        },
      );

      if (directMeal && directMeal.id) {
        const mealId = String(directMeal.id);
        const name = typeof directMeal.label === "string" ? directMeal.label : undefined;
        const calories =
          typeof (directMeal.calories as { best?: number })?.best === "number"
            ? (directMeal.calories as { best?: number }).best
            : typeof directMeal.caloriesBest === "number"
              ? (directMeal.caloriesBest as number)
              : undefined;

        return {
          success: true,
          status: "already_confirmed",
          mealId,
          name,
          calories,
          message: "This meal has already been logged.",
          meal: directMeal,
        };
      }
    } catch {
      // Not a direct meal either
    }

    // Never found: rethrow the original error so unauthorized/cross-user/non-existent drafts reject appropriately
    throw error;
  }
}

