import { readFile } from "node:fs/promises";
import { runOpenClaw } from "./openclaw-cli.js";

type Report = { selected: { defaultModel?: string; nutritionPrimary?: string; nutritionFallback?: string } };
let report: Report;
try {
  report = JSON.parse(await readFile(".model-smoke.json", "utf8")) as Report;
} catch {
  console.error("No model smoke report found. Run pnpm models:smoke first.");
  process.exit(2);
}
if (!report.selected.defaultModel || !report.selected.nutritionPrimary) {
  console.error("The authenticated smoke test did not verify a usable default and nutrition model. No OpenClaw configuration was changed.");
  process.exit(2);
}

runOpenClaw(["config", "set", "agents.defaults.model.primary", `google/${report.selected.defaultModel}`]);
const fallbacks = ["google/gemma-4-26b-a4b-it", "google/gemini-3.6-flash"].filter((m) => m !== `google/${report.selected.defaultModel}`);
runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(fallbacks), "--strict-json"]);
const configuredModels = JSON.stringify({
  [`google/${report.selected.defaultModel}`]: {},
  "google/gemma-4-26b-a4b-it": {},
  "google/gemini-3.6-flash": {},
});
runOpenClaw(["config", "set", "agents.defaults.models", configuredModels, "--strict-json", "--merge"]);
console.log(`Configured OpenClaw default model: google/${report.selected.defaultModel}`);
console.log(`Configured OpenClaw fallbacks: ${JSON.stringify(fallbacks)}`);
console.log(`Set NUTRITION_MODEL_PRIMARY=${report.selected.nutritionPrimary} in .env`);
if (report.selected.nutritionFallback) console.log(`Set NUTRITION_MODEL_FALLBACK=${report.selected.nutritionFallback} in .env`);
