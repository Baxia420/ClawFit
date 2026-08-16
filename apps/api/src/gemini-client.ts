import type { NutritionModelClient, NutritionModelRequest } from "@clawfit/health-core";

export class GeminiNutritionClient implements NutritionModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(request: NutritionModelRequest): Promise<unknown> {
    const parts: Record<string, unknown>[] = [{ text: request.prompt }];
    if (request.image) {
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
            temperature: 0.2,
            responseMimeType: "application/json",
            responseJsonSchema: nutritionJsonSchema,
          },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!text) throw new Error(payload.promptFeedback?.blockReason ? `Gemini blocked request: ${payload.promptFeedback.blockReason}` : "Gemini returned no JSON text");
    return JSON.parse(text) as unknown;
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
        properties: { name: { type: "string" }, portion_description: { type: "string" } },
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

