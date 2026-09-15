import type { NutritionModelClient, NutritionModelRequest } from "@clawfit/health-core";
export { NutritionEstimationUnavailableError } from "@clawfit/health-core";

export const PRIMARY_NUTRITION_MODEL = process.env.NUTRITION_MODEL_PRIMARY || "gemini-3.8-flash";
export const FALLBACK_NUTRITION_MODEL = process.env.NUTRITION_MODEL_FALLBACK || "gemini-3.7-flash";
export const EMERGENCY_NUTRITION_MODEL = process.env.NUTRITION_MODEL_EMERGENCY || "gemini-3.5-flash-lite";

export class UpstreamRateLimitError extends Error {
  readonly code = "UPSTREAM_RATE_LIMIT";
  readonly statusCode = 429;
  constructor(message = "Gemini rate limit exceeded. Please wait a moment.") {
    super(message);
    this.name = "UpstreamRateLimitError";
  }
}

export class UpstreamTimeoutError extends Error {
  readonly code = "UPSTREAM_TIMEOUT";
  readonly statusCode = 504;
  constructor(message = "Nutrition estimation timed out upstream.") {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

export class InvalidImagePayloadError extends Error {
  readonly code = "INVALID_PAYLOAD";
  readonly statusCode = 400;
  constructor(message = "The supplied image or text could not be processed.") {
    super(message);
    this.name = "InvalidImagePayloadError";
  }
}

export class GeminiNutritionClient implements NutritionModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(request: NutritionModelRequest): Promise<unknown> {
    const parts: Array<Record<string, unknown>> = [];
    if (request.images && Array.isArray(request.images)) {
      for (const img of request.images) {
        const rawData = (img as Record<string, unknown>).data ?? img.base64;
        if (typeof rawData === "string" && rawData) {
          parts.push({
            inlineData: {
              data: rawData.replace(/^data:[^;]+;base64,/, ""),
              mimeType: img.mimeType || "image/jpeg",
            },
          });
        }
      }
    } else if (request.image) {
      const rawData = (request.image as Record<string, unknown>).data ?? request.image.base64;
      if (typeof rawData === "string" && rawData) {
        parts.push({
          inlineData: {
            data: rawData.replace(/^data:[^;]+;base64,/, ""),
            mimeType: request.image.mimeType || "image/jpeg",
          },
        });
      }
    }
    parts.push({ text: request.prompt });

    const perAttemptTimeoutMs = 20_000;
    const timeoutSignal = AbortSignal.timeout(perAttemptTimeoutMs);
    let effectiveSignal: AbortSignal;
    if (!request.signal) {
      effectiveSignal = timeoutSignal;
    } else if (typeof AbortSignal.any === "function") {
      effectiveSignal = AbortSignal.any([request.signal, timeoutSignal]);
    } else {
      effectiveSignal = request.signal;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: nutritionJsonSchema,
            },
          }),
          signal: effectiveSignal,
        },
      );
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError" || effectiveSignal.aborted;
      if (isAbort) {
        throw new UpstreamTimeoutError();
      }
      throw err;
    }

    if (!response.ok) {
      let errorDetails = "";
      let googleStatus = "";
      try {
        const errorJson = (await response.json()) as { error?: { message?: string; status?: string; code?: number } };
        if (errorJson?.error) {
          googleStatus = errorJson.error.status ?? "";
          const status = googleStatus ? ` [${googleStatus}]` : "";
          const msg = errorJson.error.message ? `: ${errorJson.error.message}` : "";
          errorDetails = `${status}${msg}`;
        }
      } catch {
        // Non-JSON error response; status code is preserved below
      }

      console.error("Gemini upstream estimation failure", {
        status: response.status,
        googleStatus,
        details: errorDetails,
      });

      if (response.status === 429 || googleStatus === "RESOURCE_EXHAUSTED") {
        throw new UpstreamRateLimitError();
      }
      if (response.status === 400 || googleStatus === "INVALID_ARGUMENT") {
        throw new InvalidImagePayloadError(
          errorDetails ? `The supplied image or text could not be processed${errorDetails}` : undefined,
        );
      }
      if (response.status === 503 || response.status === 504 || googleStatus === "UNAVAILABLE" || googleStatus === "DEADLINE_EXCEEDED") {
        throw new UpstreamTimeoutError();
      }

      throw new Error(`Gemini request failed (${response.status})${errorDetails}`);
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!text) {
      const blockReason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason;
      throw new Error(blockReason ? `Gemini blocked request: ${blockReason}` : "Gemini returned no JSON text");
    }
    let cleanText = text.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    let data: unknown;
    try {
      data = JSON.parse(cleanText) as unknown;
    } catch (parseErr) {
      console.error("Gemini returned invalid JSON output:", cleanText);
      throw new Error(`Gemini returned unparseable JSON: ${(parseErr as Error).message}`);
    }
    const usage = payload.usageMetadata
      ? {
          promptTokens: typeof payload.usageMetadata.promptTokenCount === "number" ? payload.usageMetadata.promptTokenCount : undefined,
          candidatesTokens: typeof payload.usageMetadata.candidatesTokenCount === "number" ? payload.usageMetadata.candidatesTokenCount : undefined,
          totalTokens: typeof payload.usageMetadata.totalTokenCount === "number" ? payload.usageMetadata.totalTokenCount : undefined,
        }
      : undefined;

    return { data, usage };
  }
}

const nutritionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "items", "calories", "macros", "confidence", "uncertainty_reasons"],
  properties: {
    label: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "portion_description"],
        properties: {
          name: { type: "string" },
          portion_description: { type: "string" },
          calories: { type: ["integer", "null"] },
          protein_g: { type: ["number", "null"] },
          carbs_g: { type: ["number", "null"] },
          fat_g: { type: ["number", "null"] },
          fiber_g: { type: ["number", "null"] },
        },
      },
    },
    calories: {
      type: "object",
      additionalProperties: false,
      required: ["best", "low", "high"],
      properties: { best: { type: "integer" }, low: { type: "integer" }, high: { type: "integer" } },
    },
    macros: {
      type: "object",
      additionalProperties: false,
      required: ["protein_g", "carbs_g", "fat_g", "fiber_g"],
      properties: {
        protein_g: { type: "number" },
        carbs_g: { type: "number" },
        fat_g: { type: "number" },
        fiber_g: { type: ["number", "null"] },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    uncertainty_reasons: { type: "array", items: { type: "string" } },
  },
} as const;

