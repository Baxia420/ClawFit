import type { GoogleCredential, NutritionModelClient, NutritionModelRequest } from "@clawfit/health-core";
import { GeminiCredentialPool, quotaCooldown } from "./gemini-credential-pool.js";

type AttemptDiagnostic = {
  model: string; attempt: number; durationMs: number; status?: number;
  reason: "success" | "http_error" | "network_error" | "timeout" | "invalid_response";
  providerCode?: string;
  inputTokens?: number; outputTokens?: number; thinkingTokens?: number; totalTokens?: number;
  credentialId?: string;
  quotaScope?: "minute_or_unknown" | "daily";
  cooldownUntil?: number;
};
const providerCodes = new Set(["INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"]);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

export class GeminiNutritionClient implements NutritionModelClient {
  private readonly pool: GeminiCredentialPool;
  constructor(
    credentials: string | readonly GoogleCredential[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly diagnostic: (value: AttemptDiagnostic) => void = () => {},
    private readonly runtime = {
      now: () => Date.now(),
      wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
      random: () => Math.random(),
    },
  ) {
    this.pool = new GeminiCredentialPool(typeof credentials === "string"
      ? [{ id: "primary", envName: "GEMINI_API_KEY", apiKey: credentials }] : credentials);
  }

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
    // recovery within the Gateway's 30-second request budget; never retry writes.
    const deadline = Math.min(request.deadline ?? Infinity, this.runtime.now() + 22_000);
    const attemptedCredentials = new Set<string>();
    let credential = this.pool.select(request.model, this.runtime.now());
    if (!credential) throw new Error(this.pool.unavailableMessage());
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = this.runtime.now();
      const remaining = deadline - started;
      if (remaining <= 0) throw new Error("Gemini request timed out");
      // Another request may have cooled this slot while this one was waiting.
      credential = this.pool.select(request.model, started, attemptedCredentials, credential.id);
      if (!credential) throw new Error(this.pool.unavailableMessage());
      const credentialId = credential.id;
      const report = (value: Omit<AttemptDiagnostic, "credentialId">) => this.report({ ...value, credentialId });
      let response: Response;
      try {
        response = await this.fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": credential.apiKey },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
                responseJsonSchema: nutritionJsonSchema,
              },
            }),
            signal: AbortSignal.timeout(Math.min(12_000, remaining)),
          },
        );
      } catch (error) {
        const timeout = error instanceof Error && /TimeoutError|AbortError/.test(error.name);
        report({ model: request.model, attempt, durationMs: this.runtime.now() - started, reason: timeout ? "timeout" : "network_error" });
        if (attempt === 2 || (!timeout && !(error instanceof TypeError)) || this.runtime.now() + 1_000 >= deadline) throw new Error(timeout ? "Gemini request timed out" : "Gemini network request failed");
        await this.runtime.wait(500 + Math.floor(this.runtime.random() * 500));
        continue;
      }
      if (!response.ok) {
        // Keep only a known provider status, never its message/details (which
        // may contain user content). Preserve the HTTP code for classification.
        const body: unknown = await response.json().catch(() => null);
        const code = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "status" in body.error ? body.error.status : undefined;
        const providerCode = typeof code === "string" && providerCodes.has(code) ? code : undefined;
        const diagnostic: AttemptDiagnostic = { model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "http_error", ...(providerCode ? { providerCode } : {}) };
        if (response.status === 429) {
          const cooldown = quotaCooldown(response, body, this.runtime.now());
          this.pool.coolDown(request.model, credentialId, cooldown.until);
          attemptedCredentials.add(credentialId);
          report({ ...diagnostic, quotaScope: cooldown.scope, cooldownUntil: cooldown.until });
          const next = this.pool.select(request.model, this.runtime.now(), attemptedCredentials);
          if (attempt < 2 && next && this.runtime.now() + 1_000 < deadline) {
            credential = next;
            continue;
          }
          throw new Error("Gemini request failed (429) RESOURCE_EXHAUSTED; no eligible credential within this request budget.");
        }
        // Invalid credentials remain disabled until the process/configuration is
        // refreshed. Do not replay this request across keys for 401/403/400 errors.
        if (response.status === 401) this.pool.disable(credentialId);
        report(diagnostic);
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
        this.pool.succeed(request.model, credentialId);
        report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "success", ...counts });
        return result;
      } catch (error) {
        report({ model: request.model, attempt, status: response.status, durationMs: this.runtime.now() - started, reason: "invalid_response" });
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

