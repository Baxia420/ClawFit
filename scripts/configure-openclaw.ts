import { readFile } from "node:fs/promises";
import { loadClawFitEnv } from "./load-env.js";
import { runOpenClaw } from "./openclaw-cli.js";

loadClawFitEnv();

type ProbeResult = {
  status: "available" | "unavailable";
  modelId?: string;
  toolCalling?: "pass" | "fail" | "not-tested";
  reason?: string;
};

type Report = {
  checkedAt: string;
  results?: Record<string, ProbeResult>;
  selected?: {
    defaultModel?: string;
    nutritionPrimary?: string;
    nutritionFallback?: string;
  };
};

let report: Report;
try {
  report = JSON.parse(await readFile(".model-smoke.json", "utf8")) as Report;
} catch {
  console.error("No model smoke report found. Run pnpm models:smoke first.");
  process.exit(2);
}

const defaultModel = report.selected?.defaultModel;
const nutritionPrimary = report.selected?.nutritionPrimary;

if (!defaultModel) {
  console.error("The authenticated smoke test did not verify a usable default agent model with verified tool-calling. Run pnpm models:smoke to verify a live model.");
  process.exit(2);
}

if (!nutritionPrimary) {
  console.error("The authenticated smoke test did not verify a usable nutrition model. Run pnpm models:smoke to verify a live model.");
  process.exit(2);
}

// Find ONLY verified fallback models that passed availability and tool calling tests
const verifiedFallbacks: string[] = [];
if (report.results) {
  for (const result of Object.values(report.results)) {
    if (
      result.status === "available" &&
      result.toolCalling === "pass" &&
      result.modelId &&
      result.modelId !== defaultModel &&
      !verifiedFallbacks.includes(result.modelId)
    ) {
      verifiedFallbacks.push(result.modelId);
    }
  }
}

// Register Google models in the OpenClaw Google provider model registry
const googleProviderModels = [
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

runOpenClaw(["config", "set", "models.providers.google.models", JSON.stringify(googleProviderModels), "--strict-json"]);

const primaryId = `google/${defaultModel}`;
// General agent fallback strategy:
// Do NOT use heavy models (3.7/3.8) as generic fallbacks for the normal chat/orchestrator.
// Only configure low-cost fallback if evidence in .model-smoke.json supports it.
const candidateLiteFallback = "gemini-3.1-flash-lite";
const hasLiteFallbackSmoke = Boolean(
  report.results?.[candidateLiteFallback]?.status === "available" &&
  report.results?.[candidateLiteFallback]?.toolCalling === "pass"
);

const generalFallbacks: string[] = [];
if (hasLiteFallbackSmoke) {
  generalFallbacks.push(`google/${candidateLiteFallback}`);
} else {
  console.log(`[Evidence Note] .model-smoke.json lacks live smoke evidence for ${candidateLiteFallback}. Fallbacks kept empty (${JSON.stringify(generalFallbacks)}) to prevent unverified model invocations.`);
}

runOpenClaw(["config", "set", "agents.defaults.model.primary", primaryId]);
runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(generalFallbacks), "--strict-json"]);

// Configure allowed agent models in OpenClaw
const configuredModels: Record<string, Record<string, never>> = {
  [primaryId]: {},
  ...(hasLiteFallbackSmoke ? { [`google/${candidateLiteFallback}`]: {} } : {}),
};
runOpenClaw(["config", "set", "agents.defaults.models", JSON.stringify(configuredModels), "--strict-json", "--merge"]);

console.log(`Configured OpenClaw primary model: ${primaryId}`);
console.log(`Configured OpenClaw general fallback: ${JSON.stringify(generalFallbacks)}`);
console.log(`Registered Google provider models: gemini-3.5-flash-lite, gemini-3.7-flash, gemini-3.8-flash`);
console.log(`\nNutrition Model Routing (Health API):`);
console.log(`  Primary:  ${process.env.NUTRITION_MODEL_PRIMARY || "gemini-3.8-flash"}`);
console.log(`  Fallback: ${process.env.NUTRITION_MODEL_FALLBACK || "gemini-3.7-flash"}`);
console.log("\nModel configuration completed successfully.");
