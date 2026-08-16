import "dotenv/config";
import { writeFile } from "node:fs/promises";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing. Add your Google AI Studio key to C:\\ClawBot\\.env, then rerun: pnpm models:smoke");
  process.exit(2);
}

type CatalogModel = { name: string; displayName?: string; supportedGenerationMethods?: string[] };
type Probe = { label: string; pattern: RegExp; toolTest: boolean };

const probes: Probe[] = [
  { label: "Gemma 4 26B A4B", pattern: /gemma-4.*26b.*a4b/i, toolTest: true },
  { label: "Gemma 4 31B", pattern: /gemma-4.*31b/i, toolTest: false },
  { label: "Gemini 3.5 Flash-Lite", pattern: /gemini-3\.5.*flash[- _]?lite/i, toolTest: true },
  { label: "Gemini 3.6 Flash", pattern: /gemini-3\.6.*flash/i, toolTest: false },
  { label: "Gemini 3.7 Flash", pattern: /gemini-3\.7.*flash/i, toolTest: false },
];

const catalogResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
  headers: { "x-goog-api-key": apiKey },
  signal: AbortSignal.timeout(30_000),
});
if (!catalogResponse.ok) {
  console.error(`Google model catalog request failed (${catalogResponse.status}). Check that GEMINI_API_KEY is valid and enabled for the Gemini API.`);
  process.exit(2);
}
const catalog = (await catalogResponse.json()) as { models?: CatalogModel[] };
const models = (catalog.models ?? []).filter((model) => model.supportedGenerationMethods?.includes("generateContent"));
const results: Record<string, { status: "available" | "unavailable"; modelId?: string; toolCalling?: "pass" | "fail" | "not-tested"; reason?: string }> = {};

for (const probe of probes) {
  const found = models.find((model) => probe.pattern.test(`${model.name} ${model.displayName ?? ""}`));
  if (!found) {
    results[probe.label] = { status: "unavailable", reason: "not returned by authenticated models.list" };
    continue;
  }
  const modelId = found.name.replace(/^models\//, "");
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(
        probe.toolTest
          ? {
              contents: [{ role: "user", parts: [{ text: "Call record_number with value 7. Do not answer in prose." }] }],
              tools: [{ functionDeclarations: [{ name: "record_number", description: "Records one integer", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }] }],
              generationConfig: { maxOutputTokens: 32, temperature: 0 },
            }
          : { contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } },
      ),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { candidates?: { content?: { parts?: { functionCall?: { name?: string; args?: Record<string, unknown> } }[] } }[] };
    const functionCall = payload.candidates?.[0]?.content?.parts?.find((part) => part.functionCall)?.functionCall;
    results[probe.label] = {
      status: "available",
      modelId,
      toolCalling: probe.toolTest ? (functionCall?.name === "record_number" && functionCall.args?.value === 7 ? "pass" : "fail") : "not-tested",
    };
  } catch (error) {
    results[probe.label] = { status: "unavailable", modelId, toolCalling: probe.toolTest ? "fail" : "not-tested", reason: error instanceof Error ? error.message : "probe failed" };
  }
}

const defaultModel = selectDefault(results);
const nutritionPrimary = availableId(results["Gemini 3.7 Flash"]) ?? availableId(results["Gemini 3.6 Flash"]);
const nutritionFallback = availableId(results["Gemini 3.6 Flash"]);
const report = { checkedAt: new Date().toISOString(), results, selected: { defaultModel, nutritionPrimary, nutritionFallback } };
await writeFile(".model-smoke.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const probe of probes) {
  const result = results[probe.label]!;
  console.log(`${probe.label.padEnd(25)} ${result.status}${result.modelId ? ` (${result.modelId})` : ""}${result.toolCalling === "fail" ? " — tool calling failed" : ""}`);
}
console.log(`\nDefault model: ${defaultModel ?? "none selected"}`);
console.log(`Nutrition primary: ${nutritionPrimary ?? "none selected"}`);
console.log(`Nutrition fallback: ${nutritionFallback ?? "none selected"}`);
console.log("Saved non-secret report to .model-smoke.json");

function availableId(result: (typeof results)[string] | undefined) {
  return result?.status === "available" ? result.modelId : undefined;
}

function selectDefault(all: typeof results) {
  const gemma = all["Gemma 4 26B A4B"];
  if (gemma?.status === "available" && gemma.toolCalling === "pass") return gemma.modelId;
  const lite = all["Gemini 3.5 Flash-Lite"];
  if (lite?.status === "available" && lite.toolCalling === "pass") return lite.modelId;
  return undefined;
}

