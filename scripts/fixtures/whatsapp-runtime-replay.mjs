// Runs in a child process with a temporary OpenClaw state directory. No live
// gateway, WhatsApp connection, credentials, model or database is used.
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../packages/openclaw-health/package.json", import.meta.url));
const dist = path.dirname(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-runtime")));
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
const loadPlugins = await hostFunction("loader-", "loadOpenClawPlugins");
const wrapTool = await hostFunction("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook");
const channelFields = await hostFunction("hook-agent-context-", "buildAgentHookContextChannelFields");
const identityFields = await hostFunction("hook-agent-context-", "buildAgentHookContextIdentityFields");
const sdk = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/plugin-runtime")).href);
const { buildChannelInboundEventContext, toInboundMediaFacts } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/channel-inbound")).href);
const { finalizeInboundContext } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/reply-runtime")).href);
const directory = await mkdtemp(path.join(tmpdir(), "clawfit-host-replay-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.HEALTH_API_OPENCLAW_TOKEN = "isolated-replay-token-at-least-24-characters";
process.env.HEALTH_API_URL = "http://127.0.0.1:1";
const { saveMediaStream } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/media-store")).href);
const group = "120363000000000000@g.us", sender = "+60111111111";
const sessionKey = `agent:main:whatsapp:group:${group}`;
const pluginRoot = path.resolve(import.meta.dirname, "../../packages/openclaw-health");
const config = { plugins: { allow: ["clawfit-health"], slots: { memory: "none" }, load: { paths: [pluginRoot] }, entries: { "clawfit-health": { enabled: true, config: { allowedGroupIds: [group] } } } } };
const logs = [];
const logger = { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value), debug: () => {} };
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
const secondBytes = Buffer.concat([bytes, Buffer.from("second-original-photo")]);
try {
  async function* payload(buffer) { yield buffer; }
  // WhatsApp downloads through this same SDK store; use its authentic paths.
  const photo = (await saveMediaStream(payload(bytes), "image/png", "inbound")).path;
  const second = (await saveMediaStream(payload(secondBytes), "image/png", "inbound")).path;
  const active = loadPlugins({ config, workspaceDir: directory, activate: true, logger });
  if (!active.plugins.some(plugin => plugin.id === "clawfit-health" && plugin.status === "loaded")) throw new Error("Active plugin did not load");
  const hooks = sdk.getGlobalHookRunner();
  const discovery = loadPlugins({ config, workspaceDir: directory, activate: false, toolDiscovery: true, onlyPluginIds: ["clawfit-health"], logger });
  const entry = discovery.tools.find(tool => tool.names.includes("estimate_nutrition"));
  const activeEntry = active.tools.find(tool => tool.names.includes("estimate_nutrition"));
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ estimate: { label: "Original photo estimate" } }), { status: 200 });
  };
  const toolContext = { sessionKey, requesterSenderId: sender, messageChannel: "whatsapp", agentAccountId: "default", deliveryContext: { to: group, channel: "whatsapp", accountId: "default" } };
  const tool = entry.factory(toolContext);
  const grants = new Map();
  const originalExecute = tool.execute.bind(tool);
  tool.execute = (callId, params, ...rest) => { grants.set(callId, params); return originalExecute(callId, params, ...rest); };
  const activeTool = activeEntry.factory(toolContext);
  const ctx = await buildChannelInboundEventContext({
    channel: "whatsapp", finalize: finalizeInboundContext,
    media: toInboundMediaFacts([photo, second].map(filePath => ({ path: filePath, url: filePath, contentType: "image/png" }))),
    messageId: "photo-collection", from: group, sender: { id: sender },
    conversation: { kind: "group", id: group },
    route: { agentId: "main", accountId: "default", routeSessionKey: sessionKey },
    reply: { to: "+60333333333", originatingTo: group },
    message: { rawBody: "Estimate only. Do not save anything, including drafts." },
  });
  const replies = [];
  await hooks.runReplyDispatch({ ctx, sessionKey, inboundAudio: false, sendPolicy: "allow", shouldRouteToOriginating: false, shouldSendToolSummaries: false }, { cfg: config, dispatcher: { sendFinalReply: payload => { replies.push(payload); return true; } } });
  // No dispatch run ID. Use the actual host builders for the prompt identity.
  const runId = "collection-run";
  // Same sender and session, different background run: this must not steal
  // the current photo grant, including when both memory models fail.
  for (const trigger of ["memory", "memory", "heartbeat", "cron"]) {
    await hooks.runBeforePromptBuild({ prompt: "Background task", messages: [] }, { runId: `background-${trigger}`, trigger, sessionKey, ...channelFields({ sessionKey, messageProvider: "whatsapp", currentChannelId: group, senderId: sender }), ...identityFields({ trigger, senderId: sender, chatId: ctx.ChatId }) });
  }
  await hooks.runBeforePromptBuild({ prompt: "Old history is not authorization", messages: [] }, { runId, sessionKey, ...channelFields({ sessionKey, messageProvider: "whatsapp", currentChannelId: group, senderId: sender }), ...identityFields({ trigger: "user", senderId: sender, chatId: ctx.ChatId }) });
  // The real wrapper invokes before_tool_call with sparse runtime fields, then
  // calls a factory belonging to the distinct read-only discovery registration.
  const wrapped = wrapTool(tool, { sessionKey, runId, channelId: group }, { emitDiagnostics: false });
  const activeWrapped = wrapTool(activeTool, { sessionKey, runId, channelId: group }, { emitDiagnostics: false });
  const results = await Promise.all([wrapped.execute("collection-call-1", { text: "Food" }), activeWrapped.execute("collection-call-2", { text: "Same meal" })]);
  const write = discovery.tools.find(tool => tool.names.includes("create_pending_meal")).factory(toolContext);
  const blocked = await hooks.runBeforeToolCall({ toolName: "create_pending_meal", toolCallId: "write-call", params: {}, runId }, { sessionKey, runId, toolName: "create_pending_meal", channelId: group });
  const directWrite = await write.execute("write-call", {});
  // Also check that the registered terminal stream revokes call receipts.
  for (const entry of active.agentEventSubscriptions ?? []) {
    await entry.subscription.handle({ runId, stream: "lifecycle", data: { phase: "end" } });
  }
  const stale = await tool.execute("collection-call-1", grants.get("collection-call-1"));
  const mediaLogs = logs.filter(value => String(value).includes("[clawfit-media]"));
  const output = {
    runtimeVersion: JSON.parse(await readFile(path.join(dist, "../package.json"), "utf8")).version,
    storedInInboundCache: [photo, second].every(filePath => filePath.startsWith(path.join(directory, "media", "inbound") + path.sep)),
    distinctRegistrations: activeEntry.factory !== entry.factory,
    hooks: active.typedHooks.map(hook => hook.hookName),
    factoryHasMedia: "MediaPaths" in toolContext || "authorizedMediaPaths" in toolContext,
    factoryHasRun: "runId" in toolContext,
    dispatchHasRun: false,
    results: results.map(result => result.details),
    requestCount: requests.length,
    exactBytes: requests[0]?.images?.map(image => image.base64).join(",") === [bytes.toString("base64"), secondBytes.toString("base64")].join(","),
    blocked: blocked?.block === true,
    directWrite: directWrite.details,
    stale: stale.details,
    safeDiagnostics: mediaLogs.length > 0 && mediaLogs.every(value => !String(value).includes(sender) && !String(value).includes(group) && !String(value).includes(directory) && !String(value).includes(bytes.toString("base64")) && !String(value).includes("Estimate only")),
  };
  console.log(`CLAWFIT_REPLAY_RESULT=${JSON.stringify(output)}`);
} finally {
  sdk.resetGlobalHookRunner();
  await rm(directory, { recursive: true, force: true });
}
