import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../packages/openclaw-health/src/index.js";
import { createApp } from "../apps/api/src/create-app.js";
import { NutritionEstimator, type NutritionModelClient } from "../packages/health-core/src/nutrition.js";
import { DEFAULT_PRIMARY_USER_ID } from "../packages/db/src/index.js";
import { TEMPORARY_FAILURE } from "../packages/openclaw-health/src/inbound-turns.js";

type HealthRepository = Parameters<typeof createApp>[0]["repository"];
type Api = Parameters<typeof plugin.register>[0];
type Hook = (event: unknown, context: unknown) => unknown;
type Tool = { parameters: { properties: Record<string, unknown> }; name: string; execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
type Factory = (context: unknown) => Tool | null;
const group = "120363000000000000@g.us";
const sender = "+60111111111";
const account = "default";
const sessionKey = `agent:main:whatsapp:group:${group}`;
const estimate = { label: "Chicken", items: [{ name: "Chicken", portionDescription: "3 skewers" }], calories: { best: 300, low: 250, high: 350 }, macros: { proteinG: 30, carbsG: 10, fatG: 15, fiberG: 0 }, confidence: "medium", uncertaintyReasons: [] };
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
const sdkRequire = createRequire(new URL("../packages/openclaw-health/package.json", import.meta.url));
const { buildChannelInboundEventContext, toInboundMediaFacts } = await import(pathToFileURL(sdkRequire.resolve("openclaw/plugin-sdk/channel-inbound")).href);
const { finalizeInboundContext } = await import(pathToFileURL(sdkRequire.resolve("openclaw/plugin-sdk/reply-runtime")).href);

// Vitest resolves workspace exports with the development condition (source);
// tsc resolves their declaration files (dist). Use the same runtime class as
// the API while bridging its private declaration identity at this test boundary.
function makeEstimator(generate: NutritionModelClient["generate"]) {
  return new NutritionEstimator({ generate }, ["test-primary", "test-fallback"]) as unknown as NonNullable<Parameters<typeof createApp>[0]["estimator"]>;
}

function harness(replaceRegistryBeforePrompt = false) {
  const sessionKey = `agent:${randomUUID()}:whatsapp:group:${group}`;
  const hooks = new Map<string, Hook[]>();
  const factories: Factory[] = [];
  const subscriptions: Array<(event: unknown) => unknown> = [];
  const diagnostics: string[] = [];
  const api = {
    registrationMode: "full",
    logger: { info: (value: string) => diagnostics.push(value) },
    pluginConfig: { allowedGroupIds: [group] },
    registerTool: () => {},
    on: (name: string, handler: Hook) => hooks.set(name, [...hooks.get(name) ?? [], handler]),
    agent: { events: { registerAgentEventSubscription: (entry: { handle: (event: unknown) => unknown }) => subscriptions.push(entry.handle) } },
  } as unknown as Api;
  plugin.register(api);
  // Real host tool discovery can register a second API/module instance. Only
  // the active registration receives hooks. Factories are prepared before
  // prompt building; they receive neither attachments nor a run ID.
  plugin.register({ ...api, registrationMode: "tool-discovery", registerTool: (factory: Factory) => factories.push(factory), on: () => {}, agent: { events: { registerAgentEventSubscription: () => {} } } } as unknown as Api);
  const emit = async (name: string, event: unknown, context: unknown = {}) => {
    let result: unknown;
    for (const handler of hooks.get(name) ?? []) result = await handler(event, context) ?? result;
    return result as { params?: unknown; block?: boolean; cancel?: boolean; blockReason?: string; payload?: { text?: string; isError?: boolean } } | undefined;
  };
  async function inbound(options: { id: string; runId: string; paths?: string[]; text?: string; senderId?: string; suppress?: boolean; dispatchRunId?: boolean; mediaUrl?: string; hasPhoto?: boolean; inboundAccount?: string | null; factoryAccount?: string | null; originatingAccount?: string; skipPrompt?: boolean }) {
    const senderId = options.senderId ?? sender;
    const replies: Array<{ text?: string }> = [];
    const dispatcher = {
      waitForIdle: async () => {},
      sendFinalReply: (payload: { text?: string }) => { replies.push(payload.text === undefined ? {} : { text: payload.text }); return true; },
    };
    // Use the exact pinned SDK builder/finalizer called by WhatsApp. The input
    // is channel-owned media metadata, never an augmented model/tool context.
    const accountId = options.inboundAccount === null ? undefined : options.inboundAccount ?? account;
    const text = options.text ?? "Estimate this photo";
    const ctx = await buildChannelInboundEventContext({
      channel: "whatsapp", finalize: finalizeInboundContext,
      media: toInboundMediaFacts(options.paths?.length ? options.paths.map(filePath => ({ path: filePath, url: filePath, contentType: "image/png" })) : options.mediaUrl ? [{ url: options.mediaUrl, contentType: "image/png" }] : undefined),
      messageId: options.id, from: group, sender: { id: senderId },
      conversation: { kind: "group", id: group, label: group },
      route: { agentId: "main", accountId, routeSessionKey: sessionKey },
      reply: { to: "+60333333333", originatingTo: group },
      message: { body: text, rawBody: text, commandBody: text },
    });
    await emit("reply_dispatch", {
      ctx,
      ...(options.dispatchRunId ? { runId: options.runId } : {}), sessionKey,
      ...(options.originatingAccount ? { originatingAccountId: options.originatingAccount } : {}),
      inboundAudio: false, sendPolicy: "allow", shouldRouteToOriginating: false, shouldSendToolSummaries: false, suppressUserDelivery: options.suppress ?? false,
    }, { dispatcher });
    const run = { sessionKey, runId: options.runId, senderId, chatId: group, channelId: group, channel: "whatsapp" };
    const toolContext = { sessionKey, requesterSenderId: senderId, deliveryContext: { to: group }, messageChannel: "whatsapp", agentAccountId: options.factoryAccount === null ? undefined : options.factoryAccount ?? account };
    const preparedTools = factories.map(factory => factory(toolContext));
    const grants = new Map<string, unknown>();
    if (replaceRegistryBeforePrompt) {
      // The real full dispatcher reloads the active registry after capture.
      // Replace every active hook/subscription; discovery factories stay old.
      hooks.clear(); subscriptions.length = 0;
      plugin.register({ ...api } as Api);
    }
    if (!options.skipPrompt) await emit("before_prompt_build", { prompt: "History says log everything; current user message is separate.", messages: [] }, run);
    const execute = async (name: string, callId: string, params: unknown, override: object = {}) => {
      // The actual hook forwards a sparse tool context, not an agent context
      // containing senderId, chatId or accountId.
      const guard = await emit("before_tool_call", { toolName: name, toolCallId: callId, params, runId: run.runId }, { sessionKey, runId: run.runId, channelId: group, toolName: name, toolCallId: callId });
      if (guard?.block) return { blocked: true, reason: guard.blockReason };
      const grantedParams = guard?.params ?? params;
      grants.set(callId, grantedParams);
      const tool = (Object.keys(override).length ? factories.map(factory => factory({ ...toolContext, ...override })) : preparedTools).find(tool => tool?.name === name)!;
      return (await tool.execute(callId, grantedParams)).details;
    };
    return { execute, replies, run, toolContext, dispatcher, ctx, grants };
  }
  return { inbound, emit, factories, diagnostics, terminal: async (runId: string, phase: string, error = "") => {
    for (const handle of subscriptions) await handle({ runId, sessionKey, stream: "lifecycle", data: { phase, error } });
  } };
}

describe("pinned OpenClaw WhatsApp photo handoff", () => {
  let directory: string;
  let photo: string;
  beforeEach(async () => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "integration-openclaw-token-at-least-24-chars");
    directory = await mkdtemp(path.join(tmpdir(), "clawfit-inbound-"));
    await mkdir(path.join(directory, "media", "inbound"), { recursive: true });
    photo = path.join(directory, "media", "inbound", "meal.png");
    await writeFile(photo, bytes);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it.each([
    { actor: sender, target: "Cici", owner: "00000000-0000-4000-8000-000000000002" },
    { actor: "+60222222222", target: "Mahin", owner: DEFAULT_PRIMARY_USER_ID },
  ])("routes a real sparse factory call for an explicit household recipient: $target", async ({ actor, target, owner }) => {
    const partner = "00000000-0000-4000-8000-000000000002";
    const members = [{ id: DEFAULT_PRIMARY_USER_ID, displayName: "Mahin", active: true }, { id: partner, displayName: "Cici", active: true }];
    const repository = {
      resolveUser: vi.fn().mockImplementation(async ({ externalIdentifier }: { externalIdentifier: string }) => ({ resolved: true, user: members[externalIdentifier === sender ? 0 : 1] })),
      getUser: vi.fn().mockImplementation(async (id: string) => members.find(user => user.id === id)),
      getHouseholdForUser: vi.fn().mockResolvedValue({ household: { id: "household" } }),
      getHouseholdMembers: vi.fn().mockResolvedValue(members.map(user => ({ user }))),
      createPendingMeal: vi.fn().mockImplementation(async (userId: string, input: object) => ({ id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", userId, ...input, confirmed: false })),
    } as unknown as HealthRepository;
    const app = createApp({ repository, openclawToken: process.env.HEALTH_API_OPENCLAW_TOKEN, allowedGroupIds: [group], logger: false });
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      requests.push(url.pathname);
      const response = await app.inject({ method: "POST", url: url.pathname, headers: init.headers as Record<string,string>, payload: String(init.body) });
      return new Response(response.body, { status: response.statusCode, headers: { "x-clawfit-meal-recipient": String(response.headers["x-clawfit-meal-recipient"] ?? "") } });
    });
    const turn = await harness().inbound({ id: randomUUID(), runId: randomUUID(), senderId: actor, text: `Save this for ${target}`, paths: [photo] });
    const result = await turn.execute("create_pending_meal", "delegate", { ...estimate, source: "photo", occurredAt: "2026-10-12T05:00:00Z", rawUserText: "Model's unrelated label", idempotencyKey: "test-delegated-meal" });
    expect(result).toMatchObject({ userId: owner, recipient: { displayName: target } });
    expect(repository.createPendingMeal).toHaveBeenCalledWith(owner, expect.any(Object));
    expect(requests).toEqual(["/v1/household/meals/pending"]);
    await app.close();
  });

  it("does not let a label or invented model field select another profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "draft" })); vi.stubGlobal("fetch", fetchMock);
    const turn = await harness().inbound({ id: randomUUID(), runId: randomUUID(), text: "Log this for me", paths: [photo] });
    await turn.execute("create_pending_meal", "self-call", { ...estimate, label: "Cici's food", forPerson: "Cici", source: "photo", occurredAt: "2026-10-12T05:00:00Z", idempotencyKey: "self-only-test" });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string,string>;
    expect(headers["x-clawfit-sender-id"]).toBe(sender);
    expect(headers["x-clawfit-meal-for"]).toBe("self");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("/household/");
  });

  it("retains trusted capture when the host replaces its active registry before prompt build", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ estimate }));
    vi.stubGlobal("fetch", fetchMock);
    const turn = await harness(true).inbound({ id: "registry-reload", runId: randomUUID(), paths: [photo], text: "Estimate only, do not save" });
    expect(await turn.execute("estimate_nutrition", "reload-call", { text: "Food" })).toMatchObject({ estimate });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).image.base64).toBe(bytes.toString("base64"));
    expect(await turn.execute("create_pending_meal", "reload-write", {})).toMatchObject({ blocked: true });
  });

  it.each([
    { inboundAccount: null, factoryAccount: "default" },
    { inboundAccount: "default", factoryAccount: null },
    { inboundAccount: null, factoryAccount: null },
    { inboundAccount: "nutrition", factoryAccount: "nutrition" },
    { inboundAccount: null, originatingAccount: "nutrition", factoryAccount: "nutrition" },
  ])("binds optional account metadata using the host's default-account semantics: %j", async accounts => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const turn = await h.inbound({ id: "optional-account", runId: randomUUID(), paths: [photo], ...accounts });
    expect(turn.toolContext).not.toHaveProperty("runId");
    expect(turn.toolContext).not.toHaveProperty("MediaPaths");
    expect(turn.ctx.MediaPaths).toEqual([photo]);
    expect(await turn.execute("estimate_nutrition", "optional-call", { text: "Food" })).toMatchObject({ estimate });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { inboundAccount: null, factoryAccount: "nutrition" },
    { inboundAccount: "nutrition", factoryAccount: null },
    { inboundAccount: "nutrition", factoryAccount: "other" },
  ])("never treats a missing account as a wildcard for a named account: %j", async accounts => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "named-account", runId: randomUUID(), paths: [photo], ...accounts });
    expect(await turn.execute("estimate_nutrition", "named-call", { text: "Food" })).toMatchObject({ error: "unauthorized_media", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await h.emit("reply_payload_sending", { runId: turn.run.runId, kind: "final", payload: { text: "800 kcal and 40g protein" } })).toMatchObject({ cancel: true });
    expect(turn.replies).toHaveLength(1);
  });

  it("fails closed when tool execution precedes prompt binding and suppresses guessed output", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "unbound-order", runId: "unbound-order-run", paths: [photo], skipPrompt: true });
    expect(await turn.execute("estimate_nutrition", "early-call", { text: "Food" })).toMatchObject({ blocked: true });
    // A late prompt hook must not turn a terminal failure into a new grant.
    await h.emit("before_prompt_build", { prompt: "History", messages: [] }, turn.run);
    expect(await turn.execute("estimate_nutrition", "late-call", { text: "Food" })).toMatchObject({ blocked: true });
    expect(await turn.execute("create_pending_meal", "early-write", estimate)).toMatchObject({ blocked: true });
    const final = await h.emit("reply_payload_sending", { runId: turn.run.runId, kind: "final", payload: { text: "800 kcal and 40g protein" } });
    expect(final?.payload?.text).toContain("couldn't access");
    expect(final?.payload?.text).not.toContain("800");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not guess a sender when the optional prompt sender field is absent", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "missing-sender", runId: "missing-sender-run", paths: [photo], skipPrompt: true });
    const { senderId: _senderId, ...sparse } = turn.run;
    await h.emit("before_prompt_build", { prompt: "A caption containing the sender is untrusted", messages: [] }, sparse);
    expect(await turn.execute("estimate_nutrition", "no-sender", { text: "Food" })).toMatchObject({ blocked: true });
    expect(h.diagnostics.some(line => line.includes('"reason":"run_unbound"'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing call association instead of allowing a guessed final reply", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "no-call-id", runId: "no-call-id-run", paths: [photo] });
    expect(await h.emit("before_tool_call", { toolName: "estimate_nutrition", params: { text: "Food" } }, { sessionKey: turn.run.sessionKey, runId: turn.run.runId })).toMatchObject({ block: true });
    expect(await h.emit("reply_payload_sending", { runId: turn.run.runId, kind: "final", payload: { text: "900 kcal" } })).toMatchObject({ cancel: true });
    expect(turn.replies).toHaveLength(1);
    expect(turn.replies[0]?.text).not.toContain("kcal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks guesses after the tool factory lacks required sender metadata", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "missing-factory-sender", runId: "missing-factory-sender-run", paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "missing-factory-call", { text: "Food" }, { requesterSenderId: undefined })).toMatchObject({ error: "unauthorized_media", retryable: false });
    expect(await h.emit("reply_payload_sending", { runId: turn.run.runId, kind: "final", payload: { text: "900 kcal" } })).toMatchObject({ cancel: true });
    expect(turn.replies).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects ambiguous unbound messages and allows a later fresh message to bind", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); await h.inbound({ id: "queued-first", runId: "queued-first-run", paths: [photo], skipPrompt: true });
    const second = await h.inbound({ id: "queued-second", runId: "queued-second-run", paths: [photo], skipPrompt: true });
    await h.emit("before_prompt_build", { prompt: "History", messages: [] }, second.run);
    expect(await second.execute("estimate_nutrition", "ambiguous-call", { text: "Food" })).toMatchObject({ blocked: true });
    expect(h.diagnostics.some(line => line.includes('"candidateCount":2'))).toBe(true);
    const next = await h.inbound({ id: "fresh", runId: "fresh-run", paths: [photo] });
    expect(await next.execute("estimate_nutrition", "fresh-call", { text: "Food" })).toMatchObject({ estimate });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps separate WhatsApp-style photo messages separate even in one group session", async () => {
    const secondPhoto = path.join(path.dirname(photo), "separate-photo.png");
    const otherBytes = Buffer.concat([bytes, Buffer.from("another-message")]); await writeFile(secondPhoto, otherBytes);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const a = await h.inbound({ id: "separate-a", runId: "separate-run-a", paths: [photo] });
    const b = await h.inbound({ id: "separate-b", runId: "separate-run-b", paths: [secondPhoto], senderId: "+60222222222" });
    expect(await b.execute("estimate_nutrition", "separate-call-b", { text: "Food" })).toMatchObject({ estimate });
    expect(await a.execute("estimate_nutrition", "separate-call-a", { text: "Food" })).toMatchObject({ estimate });
    const payloads = fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(payloads.map(payload => payload.image.base64)).toEqual([otherBytes.toString("base64"), bytes.toString("base64")]);
    expect(payloads.every(payload => payload.images === undefined)).toBe(true);
  });

  it("accepts a context-side toolCallId but rejects another tool's call receipt", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "context-call", runId: "context-call-run", paths: [photo] });
    const grant = await h.emit("before_tool_call", { toolName: "estimate_nutrition", params: { text: "Food" } }, { sessionKey: turn.run.sessionKey, runId: turn.run.runId, toolCallId: "context-side", toolName: "estimate_nutrition" });
    const tool = h.factories.map(factory => factory(turn.toolContext)).find(tool => tool?.name === "estimate_nutrition")!;
    expect((await tool.execute("context-side", grant?.params)).details).toMatchObject({ estimate });
    await h.emit("before_tool_call", { toolName: "get_recent_meals", params: {}, toolCallId: "read-call" }, { sessionKey: turn.run.sessionKey, runId: turn.run.runId });
    expect((await tool.execute("read-call", { text: "Food" })).details).toMatchObject({ error: "unauthorized_media" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revokes completed and expired receipts, including cached estimates", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "completed", runId: "completed-run", paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "completed-call", { text: "Food" })).toMatchObject({ estimate });
    const tool = h.factories.map(factory => factory(turn.toolContext)).find(tool => tool?.name === "estimate_nutrition")!;
    await h.terminal(turn.run.runId, "end");
    expect((await tool.execute("completed-call", turn.grants.get("completed-call"))).details).toMatchObject({ error: "unauthorized_media" });
    const expiring = await h.inbound({ id: "expiring", runId: "expiring-run", paths: [photo] });
    expect(await expiring.execute("estimate_nutrition", "expiring-call", { text: "Food" })).toMatchObject({ estimate });
    const expiringTool = h.factories.map(factory => factory(expiring.toolContext)).find(tool => tool?.name === "estimate_nutrition")!;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect((await expiringTool.execute("expiring-call", { text: "Food" })).details).toMatchObject({ error: "unauthorized_media" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows call IDs to repeat across runs while keeping their grants isolated", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const first = await h.inbound({ id: "first", runId: "first-run", paths: [photo] });
    expect(await first.execute("estimate_nutrition", "reused-id", { text: "Food" })).toMatchObject({ estimate });
    const next = await h.inbound({ id: "second", runId: "second-run", paths: [photo] });
    expect(await next.execute("estimate_nutrition", "reused-id", { text: "Food" })).toMatchObject({ estimate });
    expect(first.grants.get("reused-id")).not.toEqual(next.grants.get("reused-id"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records only codes, counts and booleans when an authentic local attachment disappears", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "disappeared", runId: "disappeared-run", paths: [photo], text: "Private caption" });
    await rm(photo);
    expect(await turn.execute("estimate_nutrition", "disappeared-call", { text: "Private description" })).toMatchObject({ error: "image_not_found", retryable: false });
    const diagnostic = h.diagnostics.find(line => line.includes('"reason":"image_not_found"'))!;
    expect(JSON.parse(diagnostic.slice("[clawfit-media] ".length))).toMatchObject({ attachmentCount: 1, bound: true, hasTrustedMetadata: true, fileAccessSucceeded: false });
    for (const secret of [sender, group, photo, "Private caption", "Private description", bytes.toString("base64")]) expect(h.diagnostics.join("\n")).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards actual inbound bytes through the authenticated API to the estimator on the first call, without saving", async () => {
    const generate = vi.fn().mockResolvedValue(estimate);
    const repository = { resolveUser: vi.fn().mockResolvedValue({ resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, active: true } }), createMeal: vi.fn(), createPendingMeal: vi.fn(), confirmPendingMeal: vi.fn(), updateMeal: vi.fn() } as unknown as HealthRepository;
    const app = createApp({ repository, openclawToken: process.env.HEALTH_API_OPENCLAW_TOKEN, allowedGroupIds: [group], estimator: makeEstimator(generate), logger: false });
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      return new Response(response.body, { status: response.statusCode });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const turn = await h.inbound({ id: "photo-1", runId: "run-1", paths: [photo], text: "Estimate only. Do not save or log anything, including drafts." });
    expect(await turn.execute("estimate_nutrition", "estimate-1", { text: "3 chicken skewers" })).toMatchObject({ estimate, model: "test-primary" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].image).toEqual({ mimeType: "image/png", base64: bytes.toString("base64") });
    expect(repository.resolveUser).toHaveBeenCalledWith({ provider: "whatsapp", externalIdentifier: sender });
    for (const name of ["create_pending_meal", "log_meal", "confirm_pending_meal", "update_pending_meal", "update_meal"]) {
      expect(await turn.execute(name, `write-${name}`, { ...estimate, rawUserText: "log it" })).toMatchObject({ blocked: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.createPendingMeal).not.toHaveBeenCalled(); expect(repository.createMeal).not.toHaveBeenCalled(); expect(repository.confirmPendingMeal).not.toHaveBeenCalled(); expect(repository.updateMeal).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not expose paths, URIs or bytes and cannot select another sender's attachments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const a = await h.inbound({ id: "photo-a", runId: "run-a", paths: [photo] });
    const tool = h.factories.map(factory => factory(a.toolContext)).find(tool => tool?.name === "estimate_nutrition")!;
    expect(Object.keys(tool.parameters.properties)).toEqual(["text"]);
    expect(await a.execute("estimate_nutrition", "current", { text: "Food" })).toMatchObject({ estimate });
    const b = await h.inbound({ id: "photo-b", runId: "run-b", senderId: "+60222222222", hasPhoto: true });
    expect(await b.execute("estimate_nutrition", "steal", { text: "Food", imagePath: photo })).toMatchObject({ error: "invalid_estimate_request", retryable: false });
    expect(await b.execute("estimate_nutrition", "retry", { text: "Food" })).toMatchObject({ blocked: true });
    await h.terminal("run-b", "end");
    expect(b.replies[0]?.text).toContain("validate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["media://inbound/whatsapp/photo-one", "media://inbound/2026/10/photo-two"])("ignores an inbound URI containing literal slashes when trusted paths exist: %s", async mediaUrl => {
    const generate = vi.fn().mockResolvedValue(estimate);
    const repository = { resolveUser: vi.fn().mockResolvedValue({ resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, active: true } }) } as unknown as HealthRepository;
    const app = createApp({ repository, openclawToken: process.env.HEALTH_API_OPENCLAW_TOKEN, allowedGroupIds: [group], estimator: makeEstimator(generate), logger: false });
    vi.stubGlobal("fetch", vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      return new Response(response.body, { status: response.statusCode });
    }));
    const h = harness();
    const turn = await h.inbound({ id: "slash", runId: randomUUID(), paths: [photo], mediaUrl });
    expect(await turn.execute("estimate_nutrition", "slash", { text: "Food" })).toMatchObject({ estimate });
    expect(generate.mock.calls[0]?.[0].image.base64).toBe(bytes.toString("base64"));
    await app.close();
  });

  it("fails rather than degrading an image request into a text-only estimate", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const missing = await h.inbound({ id: "missing", runId: "missing-run", mediaUrl: "media://inbound/whatsapp/photo", hasPhoto: true });
    expect(await missing.execute("estimate_nutrition", "missing", { text: "Banana" })).toMatchObject({ error: "image_not_found", retryable: false });
    expect(await missing.execute("estimate_nutrition", "missing-retry", { text: "Banana" })).toMatchObject({ blocked: true });
    expect(fetchMock).not.toHaveBeenCalled();
    const unbound = h.factories.map(factory => factory(missing.toolContext)).find(tool => tool?.name === "estimate_nutrition")!;
    expect((await unbound.execute("unbound", { text: "Banana" })).details).toMatchObject({ error: "unauthorized_media", retryable: false });
  });

  it("forwards both images and quantities once even when duplicate tool calls run concurrently", async () => {
    const second = path.join(path.dirname(photo), "banana.png");
    const secondBytes = Buffer.concat([bytes, Buffer.from("second-photo")]);
    await writeFile(second, secondBytes);
    const generate = vi.fn().mockResolvedValue(estimate);
    const repository = { resolveUser: vi.fn().mockResolvedValue({ resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, active: true } }) } as unknown as HealthRepository;
    const app = createApp({ repository, openclawToken: process.env.HEALTH_API_OPENCLAW_TOKEN, allowedGroupIds: [group], estimator: makeEstimator(generate), logger: false });
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      return new Response(response.body, { status: response.statusCode });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const turn = await h.inbound({ id: "album", runId: "album-run", paths: [photo, second, photo], text: "190g fried vermicelli with carrots and eggs, and this banana. Estimate only, do not save." });
    const results = await Promise.all([turn.execute("estimate_nutrition", "album-1", { text: "Banana" }), turn.execute("estimate_nutrition", "album-2", { text: "Vermicelli" })]);
    for (const result of results) expect(result).toMatchObject({ estimate });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].images).toEqual([{ mimeType: "image/png", base64: bytes.toString("base64") }, { mimeType: "image/png", base64: secondBytes.toString("base64") }]);
    expect(generate.mock.calls[0]?.[0].prompt).toContain("190g fried vermicelli with carrots and eggs");
    expect(await turn.execute("estimate_nutrition", "album-3", { text: "Again" })).toMatchObject({ estimate });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("creates one combined photo draft even when duplicate calls supply different idempotency keys", async () => {
    const second = path.join(path.dirname(photo), "second.png");
    await writeFile(second, Buffer.concat([bytes, Buffer.from("second-photo")]));
    const fetchMock = vi.fn().mockImplementation(async (url: URL | RequestInfo) => new Response(JSON.stringify(new URL(String(url)).pathname.endsWith("/pending") ? { id: "one-draft" } : { estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "draft-album", runId: "draft-album-run", paths: [photo, second] });
    expect(await turn.execute("estimate_nutrition", "draft-estimate", { text: "Both foods" })).toMatchObject({ estimate });
    const draft = { ...estimate, source: "photo", rawUserText: "Both foods", occurredAt: "2026-10-12T10:55:00+08:00", idempotencyKey: "model-first-key" };
    const results = await Promise.all([turn.execute("create_pending_meal", "draft-first", draft), turn.execute("create_pending_meal", "draft-duplicate", { ...draft, idempotencyKey: "model-different-key" })]);
    expect(results).toEqual([{ id: "one-draft" }, { id: "one-draft" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pendingBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1].body));
    expect(pendingBody.idempotencyKey).toMatch(/^photo-draft:[a-f0-9]{64}$/);
    expect(pendingBody.idempotencyKey).not.toBe(draft.idempotencyKey);
    expect(await turn.execute("create_pending_meal", "draft-again", draft)).toEqual({ id: "one-draft" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight estimator and never writes a draft if that estimator fails", async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<Response>(resolve => { release = resolve; });
    const fetchMock = vi.fn().mockImplementation(() => { started(); return response; });
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "in-flight", runId: "in-flight-run", paths: [photo] });
    const estimating = turn.execute("estimate_nutrition", "in-flight-estimate", { text: "Food" });
    await requestStarted;
    const drafting = turn.execute("create_pending_meal", "in-flight-draft", { ...estimate, source: "photo", idempotencyKey: "guessed-draft" });
    release(new Response(JSON.stringify({ error: { code: "NUTRITION_UNAVAILABLE", message: "All models failed" } }), { status: 503 }));
    expect(await estimating).toMatchObject({ error: "NUTRITION_UNAVAILABLE", retryable: false });
    expect(await drafting).toHaveProperty("error", "meal_write_blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not permit tool-context ownership overrides or cross-account call reuse", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const a = await h.inbound({ id: "owned", runId: "owned-run", paths: [photo] });
    expect(await a.execute("estimate_nutrition", "wrong-account", { text: "Food" }, { agentAccountId: "other", authorizedMediaPaths: [photo], authContext: { senderId: sender } })).toMatchObject({ error: "unauthorized_media" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { requesterSenderId: "+60222222222" },
    { deliveryContext: { to: "another-group@g.us" } },
    { sessionKey: "another-session" },
    { agentAccountId: "other" },
  ])("does not reuse a photo or cached estimate across a different trusted identity: %j", async override => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ estimate }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "owner", runId: randomUUID(), paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "original", { text: "Food" })).toMatchObject({ estimate });
    // A disallowed group is rejected even before attachment resolution.
    const denied = await turn.execute("estimate_nutrition", "different", { text: "Food" }, override);
    expect(denied).toHaveProperty("error");
    expect(denied).not.toHaveProperty("estimate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["media://inbound/whatsapp/photo", "media://inbound/2026/meal", "media://inbound/%ZZ", "media://inbound/%2e%2e%2Fsecret", "/other/sender/meal.png"])("fails safely for %s and does not invoke inference on retry", async ref => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "bad", runId: randomUUID(), paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "bad-1", { text: "Food", imagePath: ref })).toMatchObject({ retryable: false });
    expect(await turn.execute("estimate_nutrition", "bad-2", { text: "Food" })).toMatchObject({ blocked: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects symlinks to other files even inside the inbound directory", async () => {
    const link = path.join(path.dirname(photo), "linked.png"); await symlink(photo, link);
    const h = harness(); const turn = await h.inbound({ id: "link", runId: "link-run", paths: [link] });
    expect(await turn.execute("estimate_nutrition", "link", { text: "Food" })).toMatchObject({ error: "symlink_escape", retryable: false });
  });

  it("never uses history or a model's rawUserText as logging consent", async () => {
    const h = harness(); const turn = await h.inbound({ id: "question", runId: "question-run", text: "How many calories is this?" });
    expect(await turn.execute("log_meal", "false-consent", { rawUserText: "log it" })).toMatchObject({ blocked: true });
    const confirmed = await h.inbound({ id: "yes", runId: "yes-run", text: "Yes" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "confirmed" }), { status: 200 })));
    expect(await confirmed.execute("log_meal", "confirmed", { ...estimate, rawUserText: "Yes", idempotencyKey: "confirmed-meal", occurredAt: "2026-10-11T12:00:00+08:00", source: "text" })).toEqual({ id: "confirmed" });
  });

  it("sends one temporary failure after final 503/429 exhaustion, never for an intermediate attempt", async () => {
    const h = harness(); const turn = await h.inbound({ id: "outage", runId: "outage-run", paths: [photo] });
    await h.terminal("outage-run", "finishing", "HTTP 503"); expect(turn.replies).toEqual([]);
    await h.terminal("outage-run", "error", "Primary HTTP 503, fallback HTTP 429");
    await h.terminal("outage-run", "error", "HTTP 429");
    expect(turn.replies).toEqual([{ text: TEMPORARY_FAILURE }]);
  });

  it("returns an API outage as a terminal tool error and blocks repeated estimation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "ESTIMATION_FAILED", message: "All configured nutrition models failed" } }), { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "api-error", runId: "api-run", paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "api-1", { text: "Food" })).toMatchObject({ error: "ESTIMATION_FAILED", retryable: false, message: TEMPORARY_FAILURE });
    expect(await turn.execute("estimate_nutrition", "api-2", { text: "Food" })).toMatchObject({ blocked: true });
    await h.terminal("api-run", "end"); expect(turn.replies).toEqual([{ text: TEMPORARY_FAILURE }]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("queues the failure immediately and suppresses invented nutrition after a 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "NUTRITION_UNAVAILABLE", message: "Unavailable" } }), { status: 503 })));
    const h = harness(); const turn = await h.inbound({ id: "guessed", runId: "guessed-run", paths: [photo] });
    await turn.execute("estimate_nutrition", "failed", { text: "Food" });
    // No lifecycle event or model final answer has happened yet.
    expect(turn.replies).toEqual([{ text: TEMPORARY_FAILURE }]);
    const result = await h.emit("reply_payload_sending", { runId: "guessed-run", kind: "final", payload: { text: "This meal has 850 kcal and 40g protein. Shall I log it?", mediaUrl: "old-photo" } });
    expect(result).toMatchObject({ cancel: true });
    expect(JSON.stringify(result)).not.toMatch(/850|40g|log it|old-photo/);
    await h.terminal("guessed-run", "end");
    expect(turn.replies).toEqual([{ text: TEMPORARY_FAILURE }]);
    expect(await h.emit("reply_payload_sending", { runId: "guessed-run", kind: "final", payload: { text: "850 kcal" } })).toMatchObject({ cancel: true });
    const next = await h.inbound({ id: "next", runId: "next-run", senderId: "+60222222222" });
    expect(await h.emit("reply_payload_sending", { runId: next.run.runId, kind: "final", payload: { text: "Hello" } })).toBeUndefined();
  });

  it("turns a real estimator's primary 503 and fallback 429 into a clear temporary failure without saving or retrying", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("HTTP 503 SERVICE_UNAVAILABLE")).mockRejectedValueOnce(new Error("HTTP 429 RESOURCE_EXHAUSTED"));
    const repository = { resolveUser: vi.fn().mockResolvedValue({ resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, active: true } }), createMeal: vi.fn(), createPendingMeal: vi.fn() } as unknown as HealthRepository;
    const app = createApp({ repository, openclawToken: process.env.HEALTH_API_OPENCLAW_TOKEN, allowedGroupIds: [group], estimator: makeEstimator(generate), logger: false });
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const response = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      expect(response.statusCode).toBe(503);
      return new Response(response.body, { status: response.statusCode });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "failed-estimator", runId: "failed-estimator-run", paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "failed-1", { text: "Food" })).toMatchObject({ error: "NUTRITION_UNAVAILABLE", retryable: false, message: TEMPORARY_FAILURE });
    expect(await turn.execute("estimate_nutrition", "failed-2", { text: "Food" })).toMatchObject({ blocked: true });
    expect(await h.emit("before_agent_finalize", { sessionId: "session" }, turn.run)).toMatchObject({ action: "finalize" });
    await h.terminal("failed-estimator-run", "end");
    expect(turn.replies).toEqual([{ text: TEMPORARY_FAILURE }]); expect(fetchMock).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(2);
    expect(repository.createMeal).not.toHaveBeenCalled(); expect(repository.createPendingMeal).not.toHaveBeenCalled();
    // The SDK queues its own terminal failure after lifecycle/error. Only one
    // user-facing reply is allowed even if that core error would also be sent.
    expect(await h.emit("reply_payload_sending", { runId: "failed-estimator-run", kind: "final", payload: { text: "HTTP 503", isError: true } })).toMatchObject({ cancel: true });
    expect(await h.emit("reply_payload_sending", { runId: "failed-estimator-run", kind: "final", payload: { text: TEMPORARY_FAILURE, channelData: { clawfitTerminalReply: "failed-estimator-run" } } })).toMatchObject({ payload: { text: TEMPORARY_FAILURE, isError: true } });
    expect(await h.emit("reply_payload_sending", { runId: "failed-estimator-run", kind: "final", payload: { text: TEMPORARY_FAILURE, channelData: { clawfitTerminalReply: "failed-estimator-run" } } })).toMatchObject({ cancel: true });
    await app.close();
  });

  it("fails closed for unbound meal writes, stale photos and model-provided image bytes", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness();
    const unbound = h.factories.map(factory => factory({ requesterSenderId: sender, deliveryContext: { to: group }, messageChannel: "whatsapp", sessionKey, agentAccountId: account })).find(tool => tool?.name === "create_pending_meal")!;
    expect((await unbound.execute("missing-context", estimate)).details).toMatchObject({ error: "meal_write_blocked", retryable: false });
    await h.inbound({ id: "old-photo", runId: "old-photo-run", paths: [photo] });
    const current = await h.inbound({ id: "new-text", runId: "new-text-run", text: "Estimate a banana" });
    expect(await current.execute("estimate_nutrition", "old-ref", { text: "Food", imagePath: photo })).toMatchObject({ error: "invalid_estimate_request" });
    const injected = await h.inbound({ id: "injected-bytes", runId: "injected-run", paths: [photo] });
    expect(await injected.execute("estimate_nutrition", "bytes", { text: "Food", images: [{ mimeType: "image/png", base64: bytes.toString("base64") }] })).toMatchObject({ error: "invalid_estimate_request", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not duplicate a delivered final reply or send to suppressed conversations", async () => {
    const h = harness(); const turn = await h.inbound({ id: "delivered", runId: "delivered-run", dispatchRunId: true });
    await h.emit("reply_payload_sending", { payload: { text: "Estimated 300 kcal" }, kind: "final", runId: "delivered-run", sessionKey }, { channelId: "whatsapp", conversationId: group });
    await h.terminal("delivered-run", "error", "HTTP 429"); expect(turn.replies).toEqual([]);
    const suppressed = await h.inbound({ id: "suppressed", runId: "suppressed-run", suppress: true });
    await h.terminal("suppressed-run", "error", "HTTP 503"); expect(suppressed.replies).toEqual([]);
  });
});
