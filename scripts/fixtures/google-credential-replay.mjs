// Exercise the pinned host's auth resolver and retry loop. All keys and model
// responses are fake; sockets and fetch are blocked before any host import.
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Socket } from "node:net";
Socket.prototype.connect = function () { throw new Error("Network forbidden in credential replay"); };
globalThis.fetch = async () => { throw new Error("Network forbidden in credential replay"); };
const directory = await mkdtemp(path.join(tmpdir(), "clawfit-auth-replay-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.GEMINI_API_KEY = "fake-primary";
process.env.GEMINI_API_KEY_1 = "fake-backup-one";
process.env.GEMINI_API_KEY_2 = "fake-backup-two";
const require = createRequire(new URL("../../packages/openclaw-health/package.json", import.meta.url));
const dist = path.dirname(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-runtime")));
async function hostFunction(prefix, name) {
  for (const file of (await readdir(dist)).filter(file => file.startsWith(prefix) && file.endsWith(".js"))) {
    if (!(await readFile(path.join(dist, file), "utf8")).includes(`function ${name}(`)) continue;
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
    if (fn) return fn;
  }
  throw new Error(`Pinned host function missing: ${name}`);
}
const { googleAuthConfiguration, installGoogleProfiles, validateGoogleProfiles, loadGoogleAuthSdk } = await import("../google-credential-profiles.ts");
const { readGoogleCredentials } = await import("../../packages/health-core/src/google-credentials.ts");
const credentials = readGoogleCredentials({ GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1, GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2 });
const agentDir = path.join(directory, "agents/main/agent");
await mkdir(agentDir, { recursive: true });
const plugin = path.join(directory, "fake-google");
await mkdir(plugin);
await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify({ id: "clawfit-offline-google", providers: ["google"], configSchema: { type: "object", properties: {} } }));
await writeFile(path.join(plugin, "index.js"), 'export default { id: "clawfit-offline-google", register(api) { api.registerProvider({ id: "google", label: "Offline Google", auth: [], createStreamFn: () => globalThis[Symbol.for("clawfit-auth-stream")] }); } };');
const modelId = "gemini-offline-flash-lite";
const config = {
  auth: googleAuthConfiguration({}, credentials),
  agents: { defaults: { workspace: directory, model: { primary: `google/${modelId}`, fallbacks: [] }, thinkingDefault: "off", skipBootstrap: true, timeoutSeconds: 25 } },
  models: { providers: { google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [{ id: modelId, name: "Offline fixture", api: "google-generative-ai", input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ["clawfit-offline-google"], slots: { memory: "none" }, load: { paths: [plugin] } },
  tools: { profile: "minimal", deny: ["group:runtime", "group:fs", "browser", "web_fetch"] },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const loadPlugins = await hostFunction("loader-", "loadOpenClawPlugins");
const runAgent = await hostFunction("embedded-agent-", "runEmbeddedAgent");
const hostRequire = createRequire(path.join(dist, "../package.json"));
const { createAssistantMessageEventStream } = await import(pathToFileURL(hostRequire.resolve("@openclaw/ai/event-stream")).href);
const attemptedSlots = [], models = new Set();
const exhausted = process.argv.includes("--exhausted");
globalThis[Symbol.for("clawfit-auth-stream")] = (model, _context, options) => {
  const credential = credentials.find(c => c.apiKey === options?.apiKey);
  if (!credential) throw new Error("Host did not resolve the expected environment credential");
  attemptedSlots.push(credential.id); models.add(model.id);
  if (attemptedSlots.length > 4) throw new Error("Host exceeded bounded credential pool");
  const failed = exhausted || credential.id === "primary";
  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: failed ? [] : [{ type: "text", text: "OFFLINE_AUTH_OK" }], stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "429 RESOURCE_EXHAUSTED: quota exceeded" } : {}), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }); stream.end(); });
  return stream;
};
try {
  await installGoogleProfiles(agentDir, credentials);
  await installGoogleProfiles(agentDir, credentials);
  const configuredProfiles = await validateGoogleProfiles(config, agentDir, { ...process.env, GEMINI_API_KEY_3: undefined, GEMINI_API_KEY_4: undefined, GEMINI_API_KEY_5: undefined, GEMINI_API_KEY_6: undefined, GEMINI_API_KEY_7: undefined, GEMINI_API_KEY_8: undefined });
  loadPlugins({ config, workspaceDir: directory, activate: true, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  let result;
  try { result = await runAgent({ agentId: "main", agentDir, sessionId: "auth-replay", sessionKey: "agent:main:auth-replay", workspaceDir: directory, config, prompt: "Reply with OFFLINE_AUTH_OK. Do not use tools.", provider: "google", model: modelId, runId: "auth-replay-run", timeoutMs: 25_000, trigger: "user" }); }
  catch (error) { if (!exhausted) throw error; }
  // A subsequent turn should skip the persisted primary cooldown, rather than
  // retrying the same exhausted key on every inbound message.
  if (!exhausted) await runAgent({ agentId: "main", agentDir, sessionId: "auth-replay-next", sessionKey: "agent:main:auth-replay-next", workspaceDir: directory, config, prompt: "Reply with OFFLINE_AUTH_OK.", provider: "google", model: modelId, runId: "auth-replay-next-run", timeoutMs: 25_000, trigger: "user" });
  const store = (await loadGoogleAuthSdk()).ensureAuthProfileStoreForLocalUpdate(agentDir);
  console.log("CLAWFIT_AUTH_RESULT=" + JSON.stringify({ configuredProfiles, storedReferencesOnly: credentials.every(c => !store.profiles[`google:clawfit-${c.id}`]?.key && store.profiles[`google:clawfit-${c.id}`]?.keyRef?.id === c.envName), attemptedSlots, models: [...models], succeeded: result?.payloads?.some(p => p.text?.includes("OFFLINE_AUTH_OK")) === true, cooledPrimary: store.usageStats?.["google:clawfit-primary"]?.cooldownUntil > Date.now() }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
