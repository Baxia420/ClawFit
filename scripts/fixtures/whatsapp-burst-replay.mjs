// Runs in a child process with a temporary OpenClaw state directory. No live
// gateway, WhatsApp connection, credentials, model or database is used.
import { createRequire } from "node:module";
import { installRuntimeCompatibility } from "../openclaw-runtime-compat.mjs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../packages/openclaw-health/package.json", import.meta.url));
const dist = path.dirname(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-runtime")));
const patched = process.argv.includes("--compat");
const failFirst = process.argv.includes("--fail-first");
const simultaneous = process.argv.includes("--simultaneous");
const collection = process.argv.includes("--collection");
if (patched) installRuntimeCompatibility(path.dirname(dist));
// Bundle names contain build hashes. Resolve by the pinned function's source
// declaration/export, so the test executes host code instead of recreating it.
async function hostFunction(prefix, name) {
  for (const file of (await readdir(dist)).filter(file => file.startsWith(prefix) && file.endsWith(".js"))) {
    if (!(await readFile(path.join(dist, file), "utf8")).includes(`function ${name}(`)) continue;
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
    if (fn) return fn;
  }
  throw new Error(`Pinned host function missing: ${name}`);
}
// Fail closed below HTTP: no socket can reach any external service.
const { Socket } = await import("node:net");
Socket.prototype.connect = function () { throw new Error("Network disabled in runtime fixture"); };
const directory = await mkdtemp(path.join(tmpdir(), "clawfit-burst-replay-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.HEALTH_API_OPENCLAW_TOKEN = "isolated-replay-token-at-least-24-characters";
process.env.HEALTH_API_URL = "http://127.0.0.1:1";
const { writeFile } = await import("node:fs/promises");
const { buildChannelInboundEventContext, toInboundMediaFacts } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/channel-inbound")).href);
const { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/reply-runtime")).href);
const loadPlugins = await hostFunction("loader-", "loadOpenClawPlugins");
const getActiveRegistry = await hostFunction("runtime-", "getActivePluginRegistry");
const { saveMediaStream } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/media-store")).href);
const group = "120363000000000000@g.us", sender = "+60111111111";
const sessionKey = `agent:main:whatsapp:group:${group}`;
const pluginRoot = path.resolve(import.meta.dirname, "../../packages/openclaw-health");
const fakePluginRoot = path.join(directory, "fake-model");
await mkdir(fakePluginRoot);
await writeFile(path.join(fakePluginRoot, "openclaw.plugin.json"), JSON.stringify({ id: "clawfit-offline", providers: ["clawfit-offline"], configSchema: { type: "object", properties: {} } }));
await writeFile(path.join(fakePluginRoot, "index.js"), `export default { id: "clawfit-offline", register(api) { api.on("reply_dispatch", (event) => globalThis[Symbol.for("clawfit-offline-dispatch")]?.(event)); api.registerProvider({ id: "clawfit-offline", label: "Offline fixture", auth: [], createStreamFn: () => globalThis[Symbol.for("clawfit-offline-stream")] }); } };`);
const config = {
  plugins: { allow: ["clawfit-health", "clawfit-offline"], slots: { memory: "none" }, load: { paths: [pluginRoot, fakePluginRoot] }, entries: { "clawfit-health": { enabled: true, config: { allowedGroupIds: [group] } } } },
  agents: { defaults: { workspace: directory, model: { primary: "clawfit-offline/test" }, thinkingDefault: "off", skipBootstrap: true, timeoutSeconds: 30 } },
  models: { providers: { "clawfit-offline": { api: "openai-completions", apiKey: "fake-isolated-test-key", baseUrl: "http://127.0.0.1:1", models: [{ id: "test", name: "Fake offline model", api: "openai-completions", input: ["text", "image"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  tools: { profile: "minimal", alsoAllow: ["estimate_nutrition"], deny: ["group:runtime", "group:fs", "browser", "web_fetch"] },
  messages: { suppressToolErrors: false },
  channels: { whatsapp: { groupPolicy: "allowlist", groupAllowFrom: [sender], groups: { [group]: { requireMention: false } } } },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const logs = [];
const logger = { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value), debug: () => {} };
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
let modelCalls = 0;
const apiRequests = [];
let releaseFirst, firstStarted, secondCaptured;
const firstApiStarted = new Promise(resolve => { firstStarted = resolve; });
const firstApiGate = new Promise(resolve => { releaseFirst = resolve; });
const capturedSecond = new Promise(resolve => { secondCaptured = resolve; });
const dispatchObservations = [];
globalThis[Symbol.for("clawfit-offline-dispatch")] = event => {
  dispatchObservations.push({ hasRun: Boolean(event.runId), attachmentCount: event.ctx.MediaPaths?.length ?? 0 });
  if (event.ctx.MessageSid === "photo-b") secondCaptured();
};
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address.includes("/v1/nutrition/estimate")) {
    apiRequests.push(JSON.parse(init.body));
    if (apiRequests.length === 1) {
      firstStarted(); await firstApiGate;
      if (failFirst) return Response.json({ error: { code: "ESTIMATOR_UNAVAILABLE", message: "Private provider failure" } }, { status: 503 });
    }
    return Response.json({ estimate: { label: "Offline exact photo", calories: { best: 300, low: 250, high: 350 }, macros: { proteinG: 10, carbsG: 40, fatG: 10, fiberG: 2 }, items: [], confidence: "medium", uncertaintyReasons: [] } });
  }
  throw new Error("Forbidden test network: " + new URL(address).pathname);
};
// The custom provider returns an in-memory stream. Socket blocking above is a
// second boundary if any unexpected host operation tries to access the network.
const hostRequire = createRequire(path.join(dist, "../package.json"));
const { createAssistantMessageEventStream } = await import(pathToFileURL(hostRequire.resolve("@openclaw/ai/event-stream")).href);
const fakeStream = (model, context) => {
  modelCalls++;
  const stream = createAssistantMessageEventStream();
  if (modelCalls > 8) throw new Error("Offline fixture exceeded call budget");
  // The SDK appends a user-role reminder after tool results. Inspect the last
  // non-user message rather than depending on an invented hook/run context.
  const toolResult = context.messages.filter(message => message.role !== "user").at(-1)?.role === "toolResult";
  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: toolResult ? [{ type: "text", text: "Offline estimate: 300 kcal" }] : (collection ? [1, 2] : [1]).map(index => ({ type: "toolCall", id: `call-${modelCalls}-${index}`, name: "estimate_nutrition", arguments: { text: "Current photo" } })), stopReason: toolResult ? "stop" : "toolUse", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
  return stream;
};
globalThis[Symbol.for("clawfit-offline-stream")] = fakeStream;
try {
  async function* payload() { yield bytes; }
  const photo = (await saveMediaStream(payload(), "image/png", "inbound")).path;
  const secondBytes = Buffer.concat([bytes, Buffer.from("second-photo")]);
  async function* secondPayload() { yield secondBytes; }
  const secondPhoto = (await saveMediaStream(secondPayload(), "image/png", "inbound")).path;
  loadPlugins({ config, workspaceDir: directory, activate: true, logger });
  const initialRegistry = getActiveRegistry();
  const replies = [];
  const ctx = await buildChannelInboundEventContext({ channel: "whatsapp", finalize: finalizeInboundContext, media: toInboundMediaFacts((collection ? [photo, secondPhoto] : [photo]).map(file => ({ path: file, url: file, contentType: "image/png" }))), messageId: "photo-a", from: group, sender: { id: sender }, conversation: { kind: "group", id: group }, route: { agentId: "main", accountId: "default", routeSessionKey: sessionKey }, reply: { to: "+60333333333", originatingTo: group }, message: { rawBody: "Estimate only. Do not save anything." }, extra: { CommandAuthorized: true } });
  const secondCtx = await buildChannelInboundEventContext({ channel: "whatsapp", finalize: finalizeInboundContext, media: toInboundMediaFacts([{ path: secondPhoto, url: secondPhoto, contentType: "image/png" }]), messageId: "photo-b", from: group, sender: { id: sender }, conversation: { kind: "group", id: group }, route: { agentId: "main", accountId: "default", routeSessionKey: sessionKey }, reply: { to: "+60333333333", originatingTo: group }, message: { rawBody: "Estimate only. Do not save anything." }, extra: { CommandAuthorized: true } });
  const firstRun = dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg: config, dispatcherOptions: { deliver: async (payload) => { replies.push(payload); } } });
  if (!simultaneous) await firstApiStarted;
  const secondRun = collection ? Promise.resolve(null) : dispatchReplyWithBufferedBlockDispatcher({ ctx: secondCtx, cfg: config, dispatcherOptions: { deliver: async (payload) => { replies.push(payload); } } });
  if (!patched && !collection) await capturedSecond;
  releaseFirst();
  const result = (await Promise.all([firstRun, secondRun])).filter(Boolean);
  console.log("CLAWFIT_BURST_RESULT=" + JSON.stringify({ result, replies, modelCalls, requestCount: apiRequests.length, exactBytes: apiRequests.flatMap(request => request.images ?? [request.image]).map(image => image.base64).join(",") === [bytes, secondBytes].map(buffer => buffer.toString("base64")).join(","), dispatchHasRun: dispatchObservations.some(event => event.hasRun), dispatchCount: dispatchObservations.length, registryReplaced: getActiveRegistry() !== initialRegistry, logs }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
  // The SDK owns background timers; exit only after cleanup, preserving errors.
  process.exit(process.exitCode ?? 0);
}
