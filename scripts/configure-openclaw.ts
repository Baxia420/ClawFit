import { readFile } from "node:fs/promises";
import { loadClawFitEnv } from "./load-env.js";
import { runOpenClaw } from "./openclaw-cli.js";
import { readGatewayConfig } from "./gateway-state.js";
import { z } from "zod";
import { buildModelConfiguration, OPENCLAW_VERSION } from "./openclaw-configuration.js";

loadClawFitEnv();
const version = runOpenClaw(["--version"], { capture: true }).stdout?.toString() ?? "";
if (!version.includes(OPENCLAW_VERSION)) throw new Error(`This configuration is verified for OpenClaw ${OPENCLAW_VERSION}; installed version differs.`);
const config = buildModelConfiguration(JSON.parse(await readFile(".model-smoke.json", "utf8")));
const existing = z.object({ models: z.object({ providers: z.object({ google: z.object({ apiKey: z.unknown().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().parse(await readGatewayConfig());
const { apiKey, ...routing } = config.provider;
const provider = existing.models?.providers?.google?.apiKey === undefined ? { ...routing, apiKey } : routing;
// Preserve existing provider credentials; only routing/model metadata is managed.
// One provider-level write avoids registering models with an intermediate wrong transport.
runOpenClaw(["config", "set", "models.providers.google", JSON.stringify(provider), "--strict-json", "--merge"]);
runOpenClaw(["config", "set", "agents.defaults.model.primary", config.primary]);
runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(config.fallbacks), "--strict-json"]);
runOpenClaw(["config", "set", "agents.defaults.models", JSON.stringify(config.allowedModels), "--strict-json", "--merge"]);
const policy = z.object({ healthTools: z.array(z.string()) }).parse(JSON.parse(await readFile("openclaw/policy.json", "utf8")));
// Search is the host's bounded Google-grounded tool, never a health-plugin HTTP tool.
// No implicit provider default: only a model with actual grounding evidence.
runOpenClaw(["config", "set", "tools.alsoAllow", JSON.stringify([...policy.healthTools, ...(config.webSearchModel ? ["web_search"] : [])]), "--strict-json"]);
runOpenClaw(["config", "set", "tools.web.search", JSON.stringify({ enabled: Boolean(config.webSearchModel), provider: "gemini", timeoutSeconds: 20, maxResults: 5 }), "--strict-json"]);
if (config.webSearchModel) runOpenClaw(["config", "set", "plugins.entries.google.config.webSearch.model", config.webSearchModel]);
runOpenClaw(["config", "validate"]);
console.log(`Configured Google-native routing for ${config.primary}; general fallbacks: ${config.fallbacks.join(", ") || "none verified"}.`);
console.log(`Verified nutrition candidates: ${config.nutrition.join(", ") || "none verified"}.`);
console.log("Nutrition runs on the Health API. Gateway changes do not update Render; compare its model environment with these candidates before changing anything.");

console.log(`Gateway web search: ${config.webSearchModel ?? "disabled until pnpm models:smoke --web-search verifies grounding"}`);
