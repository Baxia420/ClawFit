import { writeFile } from "node:fs/promises";
import { loadClawFitEnv } from "./load-env.js";
import { probeModels } from "./model-probes.js";
import { readGoogleCredentials } from "../packages/health-core/src/google-credentials.js";
loadClawFitEnv();
const slotArg = process.argv.indexOf("--credential");
const slot = slotArg < 0 ? "primary" : process.argv[slotArg + 1];
const credential = readGoogleCredentials(process.env).find(c => c.id === slot);
if (!credential) throw new Error("Requested Google credential slot is not configured. Use primary or backup-1 through backup-8.");
const report = await probeModels(credential.apiKey, fetch, { webSearch: process.argv.includes("--web-search") });
const reportPath = credential.id === "primary" ? ".model-smoke.json" : `.model-smoke-${credential.id}.json`;
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Saved non-secret model evidence for ${credential.id} to ${reportPath}.`);
console.log(`Default: ${report.selected.defaultModel ?? "none verified"}; general fallback: ${report.selected.generalFallback ?? "none verified"}`);
console.log(`Nutrition: ${report.selected.nutritionPrimary ?? "none verified"}; fallback: ${report.selected.nutritionFallback ?? "none verified"}`);

console.log(`Web search: ${report.selected.webSearch ?? "not verified; use --web-search to probe Google Search grounding"}`);
