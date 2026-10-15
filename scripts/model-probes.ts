import { z } from "zod";
import { selectSmokeModels, type SmokeReport } from "./openclaw-configuration.js";

const catalogSchema = z.object({ models: z.array(z.object({
  name: z.string(), displayName: z.string().optional(), supportedGenerationMethods: z.array(z.string()).optional(),
  inputTokenLimit: z.number().int().positive().optional(), outputTokenLimit: z.number().int().positive().optional(),
})).default([]), nextPageToken: z.string().optional() });
const responseSchema = z.object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({
  text: z.string().optional(), functionCall: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }).optional(),
})).optional() }).optional(), groundingMetadata: z.object({ groundingChunks: z.array(z.object({ web: z.object({ uri: z.url() }).optional() })).optional() }).optional() })).optional() });
export const modelProbes = [
  { label: "Gemma 4 26B A4B", pattern: /gemma-4.*26b.*a4b/i, image: false },
  { label: "Gemma 4 31B", pattern: /gemma-4.*31b/i, image: false },
  { label: "Gemini 3.5 Flash-Lite", pattern: /gemini-3\.5.*flash[- _]?lite/i, image: true },
  { label: "Gemini 3.6 Flash", pattern: /gemini-3\.6.*flash/i, image: true },
  { label: "Gemini 3.7 Flash", pattern: /gemini-3\.7.*flash/i, image: true },
  { label: "Gemini 3.8 Flash", pattern: /gemini-3\.8.*flash/i, image: true },
];

// Synthetic one-pixel image: no meal photos or historical reconstruction calls.
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
export async function probeModels(apiKey: string, request: typeof fetch = fetch, options: { webSearch?: boolean } = {}): Promise<SmokeReport> {
  const models: z.infer<typeof catalogSchema>["models"] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await request(url, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Google catalog failed (HTTP ${response.status}); check credentials and API access.`);
    const page = catalogSchema.parse(await response.json());
    models.push(...page.models);
    pageToken = page.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error("Google catalog returned a repeated page token.");
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  const results: SmokeReport["results"] = {};
  for (const probe of modelProbes) {
    const found = models.find(m => m.supportedGenerationMethods?.includes("generateContent") && probe.pattern.test(`${m.name} ${m.displayName ?? ""}`));
    if (!found) { results[probe.label] = { status: "unavailable", reason: "not returned by authenticated models.list" }; continue; }
    const modelId = found.name.replace(/^models\//, "");
    const result: SmokeReport["results"][string] = {
      status: "failed", modelId, toolCalling: "not-tested", imageInput: "not-tested", webSearch: "not-tested",
      ...(found.inputTokenLimit ? { contextWindow: found.inputTokenLimit } : {}),
      ...(found.outputTokenLimit ? { maxTokens: found.outputTokenLimit } : {}),
    };
    const generate = async (body: object, requireGrounding = false) => {
      const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const candidate = responseSchema.parse(await response.json()).candidates?.[0];
      if (requireGrounding && !candidate?.groundingMetadata?.groundingChunks?.some(chunk => chunk.web?.uri)) throw new Error("Missing grounded sources");
      return candidate?.content?.parts ?? [];
    };
    try {
      const parts = await generate({ contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }], generationConfig: { maxOutputTokens: 256, temperature: 0 } });
      if (!parts.some(p => p.text?.trim())) throw new Error("Empty generation response");
      result.status = "available";
      try {
        const toolParts = await generate({ contents: [{ role: "user", parts: [{ text: "Call record_number with value 7." }] }],
          tools: [{ functionDeclarations: [{ name: "record_number", description: "Records one integer", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }] }],
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["record_number"] } }, generationConfig: { maxOutputTokens: 256, temperature: 0 } });
        result.toolCalling = toolParts.some(p => p.functionCall?.name === "record_number" && p.functionCall.args?.value === 7) ? "pass" : "fail";
      } catch { result.toolCalling = "fail"; }
      if (options.webSearch && /^gemini-.*flash[-_.]?lite/i.test(modelId)) {
        try {
          const parts = await generate({ contents: [{ role: "user", parts: [{ text: "Use Google Search to find the official Node.js releases page. Cite its source." }] }], tools: [{ googleSearch: {} }], generationConfig: { maxOutputTokens: 512, temperature: 0 } }, true);
          result.webSearch = parts.some(p => p.text?.trim()) ? "pass" : "fail";
        } catch { result.webSearch = "fail"; }
      }
      if (probe.image) {
        try {
          const imageParts = await generate({ contents: [{ role: "user", parts: [{ text: "An image is attached. Reply with OK." }, { inlineData: { mimeType: "image/png", data: pixel } }] }], generationConfig: { maxOutputTokens: 256, temperature: 0 } });
          result.imageInput = imageParts.some(p => p.text?.trim()) ? "pass" : "fail";
        } catch { result.imageInput = "fail"; }
      }
    } catch (error) { result.reason = error instanceof Error && /^HTTP \d+$|^Empty generation/.test(error.message) ? error.message : "generation probe failed"; }
    results[probe.label] = result;
    console.log(`${probe.label}: ${result.status}; tool calling ${result.toolCalling}; image input ${result.imageInput}; web search ${result.webSearch}`);
  }
  return { checkedAt: new Date().toISOString(), results, selected: selectSmokeModels(results) };
}
