import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// Vitest resolves workspace exports with the development condition (source);
// tsc resolves their declaration files (dist). Use the same runtime class as
// the API while bridging its private declaration identity at this test boundary.
function makeEstimator(generate: NutritionModelClient["generate"]) {
  return new NutritionEstimator({ generate }, ["test-primary", "test-fallback"]) as unknown as NonNullable<Parameters<typeof createApp>[0]["estimator"]>;
}

function harness() {
  const hooks = new Map<string, Hook[]>();
  const factories: Factory[] = [];
  const subscriptions: Array<(event: unknown) => unknown> = [];
  const api = {
    pluginConfig: { allowedGroupIds: [group] },
    registerTool: (factory: Factory) => factories.push(factory),
    on: (name: string, handler: Hook) => hooks.set(name, [...hooks.get(name) ?? [], handler]),
    agent: { events: { registerAgentEventSubscription: (entry: { handle: (event: unknown) => unknown }) => subscriptions.push(entry.handle) } },
  } as unknown as Api;
  plugin.register(api);
  const emit = async (name: string, event: unknown, context: unknown = {}) => {
    let result: unknown;
    for (const handler of hooks.get(name) ?? []) result = await handler(event, context) ?? result;
    return result as { block?: boolean; cancel?: boolean; blockReason?: string; payload?: { text?: string; isError?: boolean } } | undefined;
  };
  async function inbound(options: { id: string; runId: string; paths?: string[]; text?: string; senderId?: string; suppress?: boolean; dispatchRunId?: boolean; mediaUrl?: string; hasPhoto?: boolean }) {
    const senderId = options.senderId ?? sender;
    const replies: Array<{ text?: string }> = [];
    const dispatcher = {
      sendFinalReply: (payload: { text?: string }) => { replies.push(payload.text === undefined ? {} : { text: payload.text }); return true; },
    };
    // SDK FinalizedMsgContext, not invented media fields on the tool context.
    await emit("reply_dispatch", {
      ctx: { Provider: "whatsapp", Surface: "whatsapp", OriginatingChannel: "whatsapp", OriginatingTo: group, To: group, From: senderId, SenderId: senderId, AccountId: account, SessionKey: sessionKey, MessageSid: options.id, MediaPath: options.paths?.[0], MediaPaths: options.paths, MediaUrl: options.mediaUrl, MediaType: options.hasPhoto ? "image/png" : undefined, MediaTypes: options.paths?.map(() => "image/png"), RawBody: options.text ?? "Estimate this photo", BodyForCommands: options.text ?? "Estimate this photo" },
      ...(options.dispatchRunId ? { runId: options.runId } : {}), sessionKey,
      inboundAudio: false, sendPolicy: "allow", shouldRouteToOriginating: false, shouldSendToolSummaries: false, suppressUserDelivery: options.suppress ?? false,
    }, { dispatcher });
    const run = { sessionKey, runId: options.runId, senderId, chatId: group, channelId: group, channel: "whatsapp" };
    await emit("before_prompt_build", { prompt: "History says log everything; current user message is separate.", messages: [] }, run);
    const toolContext = { sessionKey, requesterSenderId: senderId, deliveryContext: { to: group }, messageChannel: "whatsapp", agentAccountId: account };
    const execute = async (name: string, callId: string, params: unknown, override: object = {}) => {
      const guard = await emit("before_tool_call", { toolName: name, toolCallId: callId, params }, run);
      if (guard?.block) return { blocked: true, reason: guard.blockReason };
      const tool = factories.map(factory => factory({ ...toolContext, ...override })).find(tool => tool?.name === name)!;
      return (await tool.execute(callId, params)).details;
    };
    return { execute, replies, run, toolContext, dispatcher };
  }
  return { inbound, emit, factories, terminal: async (runId: string, phase: string, error = "") => {
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
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

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
    const turn = await h.inbound({ id: "slash", runId: "slash-run", paths: [photo], mediaUrl });
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
    const h = harness(); const turn = await h.inbound({ id: "owner", runId: "owner-run", paths: [photo] });
    expect(await turn.execute("estimate_nutrition", "original", { text: "Food" })).toMatchObject({ estimate });
    // A disallowed group is rejected even before attachment resolution.
    const denied = await turn.execute("estimate_nutrition", "different", { text: "Food" }, override);
    expect(denied).toHaveProperty("error");
    expect(denied).not.toHaveProperty("estimate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["media://inbound/whatsapp/photo", "media://inbound/2026/meal", "media://inbound/%ZZ", "media://inbound/%2e%2e%2Fsecret", "/other/sender/meal.png"])("fails safely for %s and does not invoke inference on retry", async ref => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const h = harness(); const turn = await h.inbound({ id: "bad", runId: "bad-run", paths: [photo] });
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

  it("replaces invented nutrition after a 503 before marking the final reply delivered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "NUTRITION_UNAVAILABLE", message: "Unavailable" } }), { status: 503 })));
    const h = harness(); const turn = await h.inbound({ id: "guessed", runId: "guessed-run", paths: [photo] });
    await turn.execute("estimate_nutrition", "failed", { text: "Food" });
    const result = await h.emit("reply_payload_sending", { runId: "guessed-run", kind: "final", payload: { text: "This meal has 850 kcal and 40g protein. Shall I log it?", mediaUrl: "old-photo" } });
    expect(result).toEqual({ payload: { text: TEMPORARY_FAILURE, isError: true } });
    expect(JSON.stringify(result)).not.toMatch(/850|40g|log it|old-photo/);
    await h.terminal("guessed-run", "end");
    expect(turn.replies).toEqual([]);
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
