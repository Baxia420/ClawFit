import type { NutritionModelClient, NutritionModelRequest } from "@clawfit/health-core";
import { NUTRITION_TOTAL_TIMEOUT_MS, NUTRITION_ATTEMPT_TIMEOUT_MS } from "@clawfit/health-core";

type AttemptDiagnostic = {
  model: string; attempt: number; durationMs: number; status?: number;
  reason: "success" | "http_error" | "network_error" | "timeout" | "invalid_response";
  providerCode?: string;
  inputTokens?: number; outputTokens?: number; thinkingTokens?: number; totalTokens?: number;
};
const providerCodes = new Set(["INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"]);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

export class GeminiNutritionClient implements NutritionModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly diagnostic: (value: AttemptDiagnostic) => void = () => {},
    private readonly runtime = {
      now: () => Date.now(),
      wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
      random: () => Math.random(),
    },
  ) {}

  private report(value: AttemptDiagnostic) {
    this.diagnostic({ ...value, model: /^[a-zA-Z0-9._/-]{1,100}$/.test(value.model) ? value.model : "invalid-model-id" });
  }

  async generate(request: NutritionModelRequest): Promise<unknown> {
    const parts: Record<string, unknown>[] = [{ text: request.prompt }];
    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
    } else if (request.image) {
      parts.push({ inlineData: { mimeType: request.image.mimeType, data: request.image.base64 } });
    }
    // All models/fallbacks share one deadline passed by the estimator. Keep
    // recovery within the Gateway's 75-second nutrition budget; never retry writes.
    const deadline = Math.min(request.deadline ?? Infinity, this.runtime.now() + NUTRITION_TOTAL_TIMEOUT_MS);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = this.runtime.now();
      const remaining = deadline - started;
      if (remaining <= 0) throw new Error("Gemini request timed out");
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
                temperature: 0.2,
                responseMimeType: "application/json",
                responseJsonSchema: nutritionJsonSchema,
              },
            }),
            signal: AbortSignal.timeout(Math.min(NUTRITION_ATTEMPT_TIMEOUT_MS, remaining)),
          },
        );
      } catch (error) {
        const timeout = error instanceof Error && /TimeoutError|AbortError/.test(error.name);
        this.report({ model: request.model, attempt, durationMs: this.runtime.now() - started, reason: timeout ? "timeout" : "network_error" });
        if (attempt === 2 || (!timeout && !(error instanceof TypeError)) || this.runtime.now() + 1_000 >= deadline) throw new Error(timeout ? "Gemini request timed out" : "Gemini network request failed");
        await this.runtime.wait(500 + Math.floor(this.runtime.random() * 500));
        continue;
      }
      if (!response.ok) {
        // Keep only a known provider status, never its message/details (which
        // may contain user content). Preserve the HTTP code for classification.
        const body = await response.json().catch(() => null) as { error?: { status?: unknown } } | null;
        const code = body?.error?.status;
        const providerCode = typeof code === "string" && providerCodes.has(code) ? code : undefined;
        this.report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "http_error", ...(providerCode ? { providerCode } : {}) });
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? 0 : Number(retryAfter);
        const requestedWait = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter!) - this.runtime.now());
        const waitMs = Math.max(500 + Math.floor(this.runtime.random() * 500), requestedWait);
        // A long quota cooldown needs a later user request, not a busy retry.
        if (attempt === 2 || !transientStatuses.has(response.status) || !Number.isFinite(waitMs) || waitMs > 2_000 || this.runtime.now() + waitMs + 1_000 >= deadline) throw new Error(`Gemini request failed (${response.status})${providerCode ? ` ${providerCode}` : ""}`);
        await this.runtime.wait(waitMs);
        continue;
      }
      try {
        const payload = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          promptFeedback?: { blockReason?: string };
          usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; totalTokenCount?: unknown };
        };
        const usage = payload.usageMetadata;
        const counts = Object.fromEntries(Object.entries({ inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount, thinkingTokens: usage?.thoughtsTokenCount, totalTokens: usage?.totalTokenCount }).filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
        const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
        if (!text) throw new Error(payload.promptFeedback?.blockReason ? "Gemini blocked request" : "Gemini returned no JSON text");
        const result: unknown = JSON.parse(text);
        this.report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "success", ...counts });
        return result;
      } catch (error) {
        if (error instanceof Error && /TimeoutError|AbortError/.test(error.name)) {
          this.report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "timeout" });
          throw new Error("Gemini request timed out");
        }
        this.report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "invalid_response" });
        // Do not retry malformed/blocked generation; never retain raw text in errors.
        throw new Error(error instanceof Error && error.message === "Gemini blocked request" ? error.message : "Gemini returned invalid JSON output");
      }
    }
    throw new Error("Gemini request timed out");
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

