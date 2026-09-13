import type { NutritionModelClient, NutritionModelRequest } from "@clawfit/health-core";

export class GeminiNutritionClient implements NutritionModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(request: NutritionModelRequest): Promise<unknown> {
    const parts: Record<string, unknown>[] = [{ text: request.prompt }];
    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
    } else if (request.image) {
      parts.push({ inlineData: { mimeType: request.image.mimeType, data: request.image.base64 } });
    }
    const response = await this.fetchImpl(
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
        signal: request.signal ?? AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok) {
      let errorDetails = "";
      try {
        const errorJson = (await response.json()) as { error?: { message?: string; status?: string; code?: number } };
        if (errorJson?.error) {
          const status = errorJson.error.status ? ` [${errorJson.error.status}]` : "";
          const msg = errorJson.error.message ? `: ${errorJson.error.message}` : "";
          errorDetails = `${status}${msg}`;
        }
      } catch {
        // Non-JSON error response; status code is preserved below
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
    const data = JSON.parse(text) as unknown;
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

