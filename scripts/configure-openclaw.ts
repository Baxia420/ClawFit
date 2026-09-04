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

const primaryId = `google/${defaultModel}`;
const fallbackIds = verifiedFallbacks.map((m) => `google/${m}`);

runOpenClaw(["config", "set", "agents.defaults.model.primary", primaryId]);
runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(fallbackIds), "--strict-json"]);

// Only configure the verified primary model and verified fallback models into OpenClaw
const configuredModels: Record<string, Record<string, never>> = {
  [primaryId]: {},
};
for (const fallback of fallbackIds) {
  configuredModels[fallback] = {};
}
runOpenClaw(["config", "set", "agents.defaults.models", JSON.stringify(configuredModels), "--strict-json", "--merge"]);

console.log(`Configured OpenClaw primary model: ${primaryId}`);
if (fallbackIds.length > 0) {
  console.log(`Configured OpenClaw verified fallbacks: ${JSON.stringify(fallbackIds)}`);
} else {
  console.log("No additional verified fallback models available (no unverified models were configured).");
}
console.log(`Verified Nutrition Primary model: ${nutritionPrimary}`);
if (report.selected?.nutritionFallback) {
  console.log(`Verified Nutrition Fallback model: ${report.selected.nutritionFallback}`);
} else {
  console.log("No verified Nutrition Fallback model available.");
}
console.log("\nModel configuration completed using ONLY smoke-verified models from .model-smoke.json.");
