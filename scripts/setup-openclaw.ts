import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClawFitEnv } from "./load-env.js";
import { getOpenClawJson, runOpenClaw } from "./openclaw-cli.js";

import { syncGatewayEnvironment } from "./gateway-state.js";
import { parseAllowlist, OPENCLAW_VERSION } from "./openclaw-configuration.js";

loadClawFitEnv();
const version = runOpenClaw(["--version"], { capture: true }).stdout?.toString() ?? "";
if (!version.includes(OPENCLAW_VERSION)) throw new Error(`Setup is verified for OpenClaw ${OPENCLAW_VERSION}.`);
const healthTools = await loadHealthTools();
await syncGatewayEnvironment();
const whatsappAllowFrom = parseAllowlist(process.env.CLAWFIT_WHATSAPP_ALLOW_FROM, "senders");
const allowedGroupIds = parseAllowlist(process.env.CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS, "groups");

// Explicit local gateway configuration (loopback only)
run("config", "set", "gateway.mode", "local");
run("config", "set", "gateway.bind", "loopback");
run("config", "set", "gateway.auth", JSON.stringify({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }), "--strict-json", "--merge");
run("config", "set", "gateway.remote.token", "${OPENCLAW_GATEWAY_TOKEN}");

const pluginPath = resolve("packages/openclaw-health");
const loadPaths = getOpenClawJson<string[]>("plugins.load.paths") ?? [];
if (!loadPaths.some((entry) => resolve(entry).toLowerCase() === pluginPath.toLowerCase())) loadPaths.push(pluginPath);
const enabledPlugins = ["google", "clawfit-health"];
const whatsapp = runOpenClaw(["plugins", "inspect", "whatsapp", "--json"], { capture: true, allowFailure: true });
if (whatsapp.status === 0) enabledPlugins.push("whatsapp");

run("config", "set", "plugins.load.paths", JSON.stringify(loadPaths), "--strict-json");
run("config", "set", "plugins.entries.clawfit-health.enabled", "true", "--strict-json");
// Required by the pinned host for our terminal finalization guard.
run("config", "set", "plugins.entries.clawfit-health.hooks.allowConversationAccess", "true", "--strict-json");
run("config", "set", "plugins.allow", JSON.stringify(enabledPlugins), "--strict-json");
run("config", "set", "plugins.entries.clawfit-health.config", JSON.stringify({ apiUrl: process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000" }), "--strict-json");
run("config", "set", "tools.profile", "minimal");
run("config", "set", "tools.alsoAllow", JSON.stringify(healthTools), "--strict-json");
run("config", "set", "tools.deny", JSON.stringify(["group:runtime", "group:fs", "browser", "web_fetch"]), "--strict-json");

// Health data lives in PostgreSQL. Filesystem-only memory flushes have no
// callable tools under this policy; retain compaction without those extra runs.
// Session hygiene & Compaction
run("config", "set", "session.dmScope", "per-channel-peer");
run("config", "set", "session.reset.mode", "idle");
run("config", "set", "session.reset.idleMinutes", "60", "--strict-json");
run("config", "set", "session.resetByType.direct", JSON.stringify({ mode: "idle", idleMinutes: 60 }), "--strict-json");
run("config", "set", "agents.defaults.compaction", JSON.stringify({ mode: "safeguard", reserveTokens: 8192, keepRecentTokens: 4096, maxHistoryShare: 0.5, notifyUser: false, memoryFlush: { enabled: false } }), "--strict-json");
run("config", "set", "messages.suppressToolErrors", "false", "--strict-json");
run("config", "set", "messages.inbound.debounceMs", "2000", "--strict-json");
run("config", "set", "channels.whatsapp.debounceMs", "2000", "--strict-json");

// Model registration belongs exclusively to models:configure after live smoke verification.

if (whatsappAllowFrom.length > 0) {
  run("config", "set", "channels.whatsapp.dmPolicy", "allowlist");
  run("config", "set", "channels.whatsapp.allowFrom", JSON.stringify(whatsappAllowFrom), "--strict-json");
  run("config", "set", "channels.whatsapp.groupAllowFrom", JSON.stringify(whatsappAllowFrom), "--strict-json");

  if (allowedGroupIds.length > 0) {
    run("config", "set", "channels.whatsapp.groupPolicy", "allowlist");
    const groupsConfig = Object.fromEntries(allowedGroupIds.map((id) => [id, { requireMention: false }]));
    run("config", "set", "channels.whatsapp.groups", JSON.stringify(groupsConfig), "--strict-json");
  } else {
    run("config", "set", "channels.whatsapp.groupPolicy", "disabled");
    run("config", "set", "channels.whatsapp.groups", "{}", "--strict-json");
  }
} else {
  console.warn("CLAWFIT_WHATSAPP_ALLOW_FROM is not set; existing WhatsApp sender policy was left unchanged.");
}

run("config", "validate");
console.log("ClawFit plugin, least-privilege tool policy, and session hygiene configured. Restart the Gateway after model configuration.");


function run(...args: string[]) {
  runOpenClaw(args);
}

async function loadHealthTools() {
  const policyPath = fileURLToPath(new URL("../openclaw/policy.json", import.meta.url));
  const parsed = JSON.parse(await readFile(policyPath, "utf8")) as { healthTools?: unknown };
  if (!Array.isArray(parsed.healthTools) || parsed.healthTools.length === 0 || parsed.healthTools.some((tool) => typeof tool !== "string" || !tool)) {
    throw new Error("openclaw/policy.json must define a non-empty healthTools string array");
  }
  return parsed.healthTools as string[];
}
