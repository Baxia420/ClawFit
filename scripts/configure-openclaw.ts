import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readGoogleCredentials } from "../packages/health-core/src/google-credentials.js";
import { loadClawFitEnv } from "./load-env.js";
import { runOpenClaw } from "./openclaw-cli.js";
import { gatewayPaths, readGatewayConfig } from "./gateway-state.js";
import { googleAuthConfiguration, installGoogleProfiles } from "./google-credential-profiles.js";
import { z } from "zod";
import { buildModelConfiguration, OPENCLAW_VERSION } from "./openclaw-configuration.js";

loadClawFitEnv();
const version = runOpenClaw(["--version"], { capture: true }).stdout?.toString() ?? "";
if (!version.includes(OPENCLAW_VERSION)) throw new Error(`This configuration is verified for OpenClaw ${OPENCLAW_VERSION}; installed version differs.`);
const config = buildModelConfiguration(JSON.parse(await readFile(".model-smoke.json", "utf8")));
const existing = z.object({ $include: z.unknown().optional(), auth: z.unknown().optional(), agents: z.object({ defaults: z.object({ models: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().parse(await readGatewayConfig());
if (existing.$include) throw new Error("Included Gateway configuration requires explicit reconciliation before credential setup.");
const credentials = readGoogleCredentials(process.env);
const auth = googleAuthConfiguration(existing.auth, credentials);
await installGoogleProfiles(resolve(gatewayPaths().stateDir, "agents/main/agent"), credentials);
// Only environment references enter the auth store. Remove the old explicit
// provider key and stale model list so native profile rotation owns credentials.
runOpenClaw(["config", "set", "auth", JSON.stringify(auth), "--strict-json"]);
runOpenClaw(["config", "set", "models.providers.google", JSON.stringify(config.provider), "--strict-json"]);
runOpenClaw(["config", "set", "agents.defaults.model.primary", config.primary]);
runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(config.fallbacks), "--strict-json"]);
const allowedModels = Object.fromEntries(Object.entries(existing.agents?.defaults?.models ?? {}).filter(([id]) => !/^google\/gemma-/i.test(id)));
runOpenClaw(["config", "set", "agents.defaults.models", JSON.stringify({ ...allowedModels, ...config.allowedModels }), "--strict-json"]);
const policy = z.object({ healthTools: z.array(z.string()) }).parse(JSON.parse(await readFile("openclaw/policy.json", "utf8")));
// Search is the host's bounded Google-grounded tool, never a health-plugin HTTP tool.
// No implicit provider default: only a model with actual grounding evidence.
runOpenClaw(["config", "set", "tools.alsoAllow", JSON.stringify([...policy.healthTools, ...(config.webSearchModel ? ["web_search"] : [])]), "--strict-json"]);
runOpenClaw(["config", "set", "tools.web.search", JSON.stringify({ enabled: Boolean(config.webSearchModel), provider: "gemini", timeoutSeconds: 20, maxResults: 5 }), "--strict-json"]);
if (config.webSearchModel) runOpenClaw(["config", "set", "plugins.entries.google.config.webSearch.model", config.webSearchModel]);
runOpenClaw(["config", "validate"]);
console.log(`Configured Google-native routing for ${config.primary}; ${credentials.length} credential profile(s); native credential failover within the existing turn limits. General model fallbacks disabled.`);
console.log(`Verified nutrition candidates: ${config.nutrition.join(", ") || "none verified"}.`);
console.log("Nutrition runs on the Health API. Gateway changes do not update Render; compare its model environment with these candidates before changing anything.");

console.log(`Gateway web search: ${config.webSearchModel ?? "disabled until pnpm models:smoke --web-search verifies grounding"}`);
