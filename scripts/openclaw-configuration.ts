import { z } from "zod";

export const GOOGLE_API = "google-generative-ai";
export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const OPENCLAW_VERSION = "2026.7.1-2";

const probeSchema = z.object({
  status: z.enum(["available", "unavailable", "failed", "not-tested"]),
  modelId: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  toolCalling: z.enum(["pass", "fail", "not-tested"]).optional(),
  webSearch: z.enum(["pass", "fail", "not-tested"]).optional(),
  webSearchReason: z.string().regex(/^(?:HTTP [0-9]{3}|missing_grounded_sources|timeout|invalid_response)$/).optional(),
  imageInput: z.enum(["pass", "fail", "not-tested"]).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reason: z.string().optional(),
});
export const smokeReportSchema = z.object({
  checkedAt: z.iso.datetime(),
  results: z.record(z.string(), probeSchema),
  selected: z.object({
    defaultModel: z.string().optional(),
    generalFallback: z.string().optional(),
    nutritionPrimary: z.string().optional(),
    nutritionFallback: z.string().optional(),
    webSearch: z.string().optional(),
  }),
});
export type SmokeReport = z.infer<typeof smokeReportSchema>;

export function buildModelConfiguration(input: unknown, now = Date.now()) {
  const report = smokeReportSchema.parse(input);
  const age = now - Date.parse(report.checkedAt);
  if (age > 7 * 86400_000 || age < -300_000) throw new Error("Model smoke report is stale or future-dated. Run pnpm models:smoke.");
  const verified = Object.values(report.results).filter(p => p.status === "available" && p.modelId);
  const primary = verified.find(p => p.modelId === report.selected.defaultModel && p.toolCalling === "pass");
  if (!primary?.modelId) throw new Error("No smoke-verified default model with working tool calling.");
  if (!isLowCostAgentModel(primary.modelId)) throw new Error("Default agent selection must be a verified low-cost model.");
  // Only the explicitly tested low-cost candidates may be general-chat fallbacks.
  const fallback = verified.find(p => p.modelId === report.selected.generalFallback && p.toolCalling === "pass");
  if (fallback && !isLowCostAgentModel(fallback.modelId!)) throw new Error("General fallback must be a verified low-cost model.");
  const generalFallbacks = fallback?.modelId && fallback.modelId !== primary.modelId ? [`google/${fallback.modelId}`] : [];
  const selectedIds = new Set([primary.modelId, ...generalFallbacks.map(id => id.slice(7))]);
  const nutrition: string[] = [];
  for (const id of [report.selected.nutritionPrimary, report.selected.nutritionFallback]) {
    if (!id || nutrition.includes(id)) continue;
    const probe = verified.find(p => p.modelId === id && p.imageInput === "pass");
    if (!probe) throw new Error("Nutrition selection lacks a successful image-input smoke test. Run pnpm models:smoke.");
    nutrition.push(id);
    selectedIds.add(id);
  }
  const search = verified.find(p => p.modelId === report.selected.webSearch && p.webSearch === "pass" && /^gemini-/i.test(p.modelId!) && isLowCostAgentModel(p.modelId!));
  if (report.selected.webSearch && !search) throw new Error("Web search requires a verified low-cost Google Search grounding probe.");
  if (search?.modelId) selectedIds.add(search.modelId);
  const models = [...selectedIds].map(id => {
    const probe = verified.find(p => p.modelId === id)!;
    return {
      id, name: id, api: GOOGLE_API, baseUrl: GOOGLE_BASE_URL,
      input: probe.imageInput === "pass" ? ["text", "image"] : ["text"],
      ...(probe.contextWindow ? { contextWindow: probe.contextWindow } : {}),
      ...(probe.maxTokens ? { maxTokens: probe.maxTokens } : {}),
    };
  });
  return {
    provider: { api: GOOGLE_API, baseUrl: GOOGLE_BASE_URL, apiKey: "${GEMINI_API_KEY}", models },
    primary: `google/${primary.modelId}`,
    fallbacks: generalFallbacks,
    allowedModels: Object.fromEntries([`google/${primary.modelId}`, ...generalFallbacks].map(id => [id, {}])),
    nutrition,
    webSearchModel: search?.modelId,
  };
}

export function isLowCostAgentModel(id: string): boolean {
  return /flash[-_.]?lite/i.test(id) || /^gemma-.*26b.*a4b/i.test(id);
}

export function selectSmokeModels(results: SmokeReport["results"]): SmokeReport["selected"] {
  const available = Object.values(results).filter(p => p.status === "available" && p.modelId);
  const agents = available.filter(p => p.toolCalling === "pass" && isLowCostAgentModel(p.modelId!));
  const defaultModel = agents.find(p => /flash[-_.]?lite/i.test(p.modelId!))?.modelId ?? agents[0]?.modelId;
  const generalFallback = agents.find(p => p.modelId !== defaultModel)?.modelId;
  const nutrition = available.filter(p => p.imageInput === "pass" && /^gemini-/i.test(p.modelId!) && !/lite/i.test(p.modelId!));
  // Preference is explicit; no unavailable or untested model enters runtime config.
  nutrition.sort((a,b) => b.modelId!.localeCompare(a.modelId!, undefined, { numeric: true }));
  const webSearch = available.find(p => p.webSearch === "pass" && /^gemini-/i.test(p.modelId!) && isLowCostAgentModel(p.modelId!))?.modelId;
  return {
    ...(webSearch ? { webSearch } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(generalFallback ? { generalFallback } : {}),
    ...(nutrition[0]?.modelId ? { nutritionPrimary: nutrition[0].modelId } : {}),
    ...(nutrition[1]?.modelId ? { nutritionFallback: nutrition[1].modelId } : {}),
  };
}

export function parseAllowlist(value: string | undefined, kind: "senders" | "groups"): string[] {
  if (!value?.trim()) return [];
  const entries: unknown = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",").map(s => s.trim());
  const pattern = kind === "senders" ? /^\+\d{8,15}$/ : /^\d+(?:-\d+)?@g\.us$/;
  return [...new Set(z.array(z.string().regex(pattern)).parse(entries))];
}

// Used by preflight as well as tests; reject allowed-but-disabled search and
// implicit SDK model defaults. Credential resolution stays inside OpenClaw.
export function validateGatewaySearch(input: unknown): string[] {
  const config = z.object({ tools: z.object({ alsoAllow: z.array(z.string()), web: z.object({ search: z.object({ enabled: z.boolean().optional() }).passthrough().optional() }).optional() }) }).passthrough().parse(input);
  const allowed = config.tools.alsoAllow.includes("web_search");
  if (!allowed && config.tools.web?.search?.enabled !== true) return [];
  if (!allowed) throw new Error("Enabled web search is missing from the tool allowlist.");
  const parsed = z.object({
    tools: z.object({ web: z.object({ search: z.object({ enabled: z.literal(true), provider: z.literal("gemini") }) }) }),
    plugins: z.object({ allow: z.array(z.string()).refine(ids => ids.includes("google")), entries: z.object({ google: z.object({ config: z.object({ webSearch: z.object({ model: z.string().regex(/^gemini-/).refine(isLowCostAgentModel) }) }) }) }) }),
    models: z.object({ providers: z.object({ google: z.object({ models: z.array(z.object({ id: z.string() })) }) }) }),
  }).parse(input);
  if (!parsed.models.providers.google.models.some(model => model.id === parsed.plugins.entries.google.config.webSearch.model)) throw new Error("Search model is not registered.");
  return ["web_search"];
}
