import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenClawJson, runOpenClaw } from "./openclaw-cli.js";

const healthTools = [
  "estimate_nutrition", "get_pending_meal", "confirm_pending_meal", "log_meal", "update_meal", "delete_meal", "get_meal", "get_recent_meals", "get_daily_nutrition",
  "save_food_preset", "find_food_preset", "update_food_preset", "delete_food_preset", "start_workout", "get_active_workout",
  "add_workout_set", "update_workout_set", "delete_workout_set", "finish_workout", "get_previous_exercise_performance", "get_workout_history",
];

loadProjectEnv();
await syncGatewayEnv();

const pluginPath = resolve("packages/openclaw-health");
const loadPaths = getOpenClawJson<string[]>("plugins.load.paths") ?? [];
if (!loadPaths.some((entry) => resolve(entry).toLowerCase() === pluginPath.toLowerCase())) loadPaths.push(pluginPath);
const enabledPlugins = ["google", "clawfit-health"];
const whatsapp = runOpenClaw(["plugins", "inspect", "whatsapp", "--json"], { capture: true, allowFailure: true });
if (whatsapp.status === 0) enabledPlugins.push("whatsapp");

run("config", "set", "plugins.load.paths", JSON.stringify(loadPaths), "--strict-json");
run("config", "set", "plugins.entries.clawfit-health.enabled", "true", "--strict-json");
run("config", "set", "plugins.allow", JSON.stringify(enabledPlugins), "--strict-json");
run("config", "set", "plugins.entries.clawfit-health.config", JSON.stringify({ apiUrl: process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000" }), "--strict-json");
run("config", "set", "tools.profile", "minimal");
run("config", "set", "tools.alsoAllow", JSON.stringify(healthTools), "--strict-json");
run("config", "set", "tools.deny", JSON.stringify(["group:runtime", "group:fs", "browser", "web_fetch"]), "--strict-json");

// Session hygiene & Compaction
run("config", "set", "session.dmScope", "per-channel-peer");
run("config", "set", "session.reset.mode", "idle");
run("config", "set", "session.reset.idleMinutes", "60", "--strict-json");
run("config", "set", "session.resetByType.direct", JSON.stringify({ mode: "idle", idleMinutes: 60 }), "--strict-json");
run("config", "set", "agents.defaults.compaction", JSON.stringify({ mode: "safeguard", reserveTokens: 8192, keepRecentTokens: 4096, maxHistoryShare: 0.5, notifyUser: false }), "--strict-json");
run("config", "set", "messages.suppressToolErrors", "true", "--strict-json");

console.log("ClawFit plugin, least-privilege tool policy, and session hygiene configured. Restart the Gateway after model configuration.");


function run(...args: string[]) {
  runOpenClaw(args);
}

function loadProjectEnv() {
  const projectEnv = fileURLToPath(new URL("../.env", import.meta.url));
  try {
    process.loadEnvFile(projectEnv);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncGatewayEnv() {
  const variables = ["GEMINI_API_KEY", "HEALTH_API_TOKEN", "HEALTH_API_URL"] as const;
  const missing = variables.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing required project environment variables: ${missing.join(", ")}`);

  const gatewayEnvPath = resolve(homedir(), ".openclaw", ".env");
  let content = "";
  try {
    content = await readFile(gatewayEnvPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : [];
  for (const name of variables) {
    const replacement = `${name}=${process.env[name]}`;
    const index = lines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (index === -1) lines.push(replacement);
    else lines[index] = replacement;
  }

  await mkdir(dirname(gatewayEnvPath), { recursive: true });
  await writeFile(gatewayEnvPath, `${lines.filter((line, index) => line || index < lines.length - 1).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  console.log("Synchronized required ClawFit variables to the OpenClaw Gateway environment (values hidden).");
}
