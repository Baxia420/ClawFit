import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MAX_MODEL_CALLS, TURN_TIMEOUT_MS } from "./inbound-turns.js";
import { isDraftCancellationRequest } from "./confirmation.js";

const { abort } = vi.hoisted(() => ({ abort: vi.fn(() => true) }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({ abortAgentHarnessRun: abort }));
const estimate = { label: "Lunch", calories: { best: 300, low: 250, high: 350 }, macros: { proteinG: 10, carbsG: 40, fatG: 10, fiberG: null }, confidence: "medium", uncertaintyReasons: [] };
const draftId = "10000000-0000-4000-8000-000000000001";
const profile = { userId: "partner-id", displayName: "Cici" };
const draft = () => ({ ...estimate, id: draftId, confirmed: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), recipient: profile });

async function harness(text: string, extra: object = {}) {
  vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token");
  const hooks = new Map<string, Function[]>(), factories: Function[] = [], replies: any[] = [], logs: string[] = [], terminalHandlers: Function[] = [];
  const api: any = { agent: { events: { registerAgentEventSubscription: (subscription: any) => terminalHandlers.push(subscription.handle) } }, registrationMode: "full", on: (name: string, hook: Function) => hooks.set(name, [...hooks.get(name) ?? [], hook]), registerTool: (factory: Function) => factories.push(factory), logger: { info: (value: string) => logs.push(value) } };
  plugin.register(api);
  const runId = randomUUID(), sessionKey = randomUUID(), sessionId = randomUUID();
  const context = { runId, sessionKey, sessionId, senderId: "+60111111111", chatId: "+60111111111", trigger: "user" };
  const emit = async (name: string, event: object, ctx: object = context): Promise<any> => {
    let result;
    for (const hook of hooks.get(name) ?? []) result = await hook(event, ctx) ?? result;
    return result;
  };
  await emit("reply_dispatch", { runId, sendPolicy: "allow", sessionKey, ctx: { Provider: "whatsapp", SessionKey: sessionKey, SenderId: context.senderId, To: context.chatId, MessageSid: randomUUID(), RawBody: text, ...extra } }, { dispatcher: { waitForIdle: async () => {}, sendFinalReply: (reply: object) => { replies.push(reply); return true; } }, markIdle: vi.fn() });
  await emit("before_prompt_build", { prompt: text, messages: [] });
  const toolContext = { sessionKey, sessionId, requesterSenderId: context.senderId, deliveryContext: { to: context.chatId }, messageChannel: "whatsapp" };
  const call = async (name: string, params: object = {}) => {
    const toolCallId = randomUUID();
    const guard = await emit("before_tool_call", { toolName: name, params, toolCallId, runId });
    if (guard?.block) return guard;
    const tool = factories.map(factory => factory(toolContext)).find(tool => tool?.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return (await tool.execute(toolCallId, guard?.params ?? params)).details;
  };
  return { call, emit, replies, logs, context, terminal: async (phase: string) => { for (const handler of terminalHandlers) await handler({ runId, stream: "lifecycle", data: { phase } }); }, final: (text: string) => emit("reply_payload_sending", { runId, kind: "final", payload: { text } }) };
}

afterEach(() => { if (vi.isFakeTimers()) vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("stops on the first no-save veto, delivers once, and rejects subsequent calls", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Estimate only. Don't save anything.");
  expect(await h.call("create_pending_meal")).toMatchObject({ block: true });
  expect(abort).toHaveBeenCalledExactlyOnceWith(h.context.sessionId);
  expect(await h.call("get_pending_meal")).toMatchObject({ block: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.replies).toHaveLength(1);
  expect(h.logs.some(log => log.includes('"reason":"policy_veto"'))).toBe(true);
});

it.each(["Don't log it, clear the pending draft", "Estimate only; cancel this draft"])("separates cancellation intent from no-save: %s", async text => {
  expect(isDraftCancellationRequest(text)).toBe(true);
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(draft())).mockResolvedValueOnce(Response.json({ id: draftId, cancelledAt: new Date().toISOString(), recipient: profile }));
  vi.stubGlobal("fetch", fetchMock);
  const h = await harness(text);
  expect(await h.call("delete_pending_meal", { pendingDraftId: draftId })).toMatchObject({ status: "cancelled", pendingDraftId: draftId });
  expect(fetchMock.mock.calls.map(([url, init]) => [new URL(url).pathname, init.method])).toEqual([[`/v1/meals/pending/${draftId}`, "GET"], [`/v1/meals/pending/${draftId}`, "DELETE"]]);
  expect((await h.final("Cleared every meal!" )).payload.text).toBe("Pending meal draft cancelled for Cici.");
});

it.each(["Don't cancel this draft", "Did you cancel this draft?", 'She said "cancel the draft"'])("does not authorize cancellation: %s", async text => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const h = await harness(text);
  expect(await h.call("delete_pending_meal", { pendingDraftId: draftId })).toMatchObject({ block: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  { value: { pending: [] }, params: {}, status: "not_found", message: "No matching pending" },
  { value: { ...draft(), confirmed: true }, params: { pendingDraftId: draftId }, status: "already_confirmed", message: "logged meal was left unchanged" },
  { value: { ...draft(), cancelledAt: "2026-01-01T00:00:00Z" }, params: { pendingDraftId: draftId }, status: "already_cancelled", message: "already cancelled" },
  { value: { ...draft(), expiresAt: "2026-01-01T00:00:00Z" }, params: { pendingDraftId: draftId }, status: "expired", message: "has expired" },
])("reports cancellation state $status without deleting a logged meal", async ({ value, params, status, message }) => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(value)); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Cancel the pending meal draft");
  expect(await h.call("delete_pending_meal", params)).toMatchObject({ status });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await h.final("All cleared successfully")).payload.text).toContain(message);
});

it("will not choose silently between two pending drafts", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ pending: [draft(), { ...draft(), id: randomUUID() }] })); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Cancel the draft");
  await h.call("delete_pending_meal");
  expect(h.replies[0].text).toContain("More than one");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await h.call("delete_pending_meal")).toMatchObject({ block: true });
});

it("does not claim cancellation when only a read happened", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ pending: [draft()] })));
  const h = await harness("Clear the pending draft"); await h.call("get_pending_meal");
  expect((await h.final("I cleared it")).payload.text).toContain("couldn't verify a completed draft cancellation");
});

it("blocks the logged-meal delete tool for an explicit draft request", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Delete the pending draft");
  expect(await h.call("delete_meal", { id: draftId })).toMatchObject({ block: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.replies[0].text).toContain("Logged-meal deletion was blocked");
});

it("does not offer logging without a matching active draft receipt", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ estimate })));
  const h = await harness("Estimate this meal"); await h.call("estimate_nutrition", { text: "Lunch" });
  const reply = (await h.final("Reply yes to log it")).payload.text;
  expect(reply).toContain("300 kcal"); expect(reply).not.toContain("Reply yes");
});

it("offers confirmation only after the API creates a matching draft", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ estimate })).mockResolvedValueOnce(Response.json(draft())));
  const h = await harness("Estimate this meal"); await h.call("estimate_nutrition", { text: "Lunch" }); await h.call("create_pending_meal", {});
  expect((await h.final("Looks good")).payload.text).toContain("Reply yes to log it");
});

it("requires a recipient for a retry quoting someone else's photo", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Try this photo again", { ReplyToId: "partner-photo", ReplyToSender: "+60222222222" });
  expect(await h.call("create_pending_meal")).toMatchObject({ block: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.replies[0].text).toContain("name the person");
});

it("explains a rejected household recipient once without weakening authorization", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "FORBIDDEN", message: "private membership details" } }, { status: 403 })); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Log this for Unknown"); await h.call("create_pending_meal", {});
  expect(h.replies[0].text).toContain("one active household member");
  expect(h.replies[0].text).not.toContain("private");
  expect(await h.call("create_pending_meal", {})).toMatchObject({ block: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not guess a meal owner from model prose", async () => {
  const h = await harness("Who is this meal for?");
  expect((await h.final("It belongs to Mahin")).payload.text).toContain("haven't verified");
});

it("does not intercept an unrelated ownership question", async () => {
  const h = await harness("Who owns this company?");
  expect(await h.final("The company belongs to its shareholders.")).toBeUndefined();
});

it.each(["I cleared the draft.", "Deleted!", "This meal belongs to Mahin."])("suppresses unsupported claims even without an explicit action request: %s", async claim => {
  const h = await harness("Don't log this");
  expect((await h.final(claim)).payload.text).toContain("couldn't verify a completed meal action");
});

it("retains a successful write receipt when a later operation fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(draft())).mockRejectedValueOnce(new TypeError("lost connection")));
  const h = await harness("Log this meal"); await h.call("create_pending_meal", {}); await h.call("get_daily_nutrition", { date: "2026-10-19" });
  expect(h.replies[0].text).toContain("Meal draft saved for Cici");
  expect(h.replies[0].text).toContain("Check the current meals and drafts");
});

it("ends a stalled model turn at the deadline and logs only safe usage", async () => {
  vi.useFakeTimers(); const h = await harness("Estimate lunch");
  await h.emit("model_call_started", { ...h.context, callId: "first", provider: "google", model: "test" });
  await h.emit("llm_output", { runId: h.context.runId, usage: { input: 100, output: 20, total: 120, secret: "private" } });
  await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
  expect(abort).toHaveBeenCalledExactlyOnceWith(h.context.sessionId);
  expect(h.replies).toHaveLength(1);
  expect(JSON.stringify(h.logs)).toContain('model_usage');
  expect(JSON.stringify(h.logs)).not.toMatch(/private|60111111111/);
});

it("never lets an old deadline abort a new run in the same session", async () => {
  vi.useFakeTimers(); const h = await harness("Estimate lunch");
  await h.emit("model_call_started", { ...h.context, callId: "first" });
  await h.emit("model_call_started", { ...h.context, runId: "different-current-run", callId: "next" });
  await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
  expect(abort).not.toHaveBeenCalled(); expect(h.replies).toHaveLength(0);
});

it("caps model cycles even when tools keep making progress", async () => {
  const h = await harness("Check meals");
  for (let n = 0; n <= MAX_MODEL_CALLS; n++) await h.emit("model_call_started", { ...h.context, callId: `attempt-${n}` });
  expect(abort).toHaveBeenCalledExactlyOnceWith(h.context.sessionId); expect(h.replies).toHaveLength(1);
});


it("preserves completed workout replies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ id: randomUUID() })));
  const h = await harness("Log my workout"); await h.call("start_workout", { title: "Push" });
  expect(await h.final("Logged your Push workout.")).toBeUndefined();
});

it("preserves quoted serving information for nutrition without using it as consent", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ estimate })); vi.stubGlobal("fetch", fetchMock);
  const h = await harness('Estimate the packet marked "200 ml"'); await h.call("estimate_nutrition", { text: "Drink" });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toContain('"200 ml"');
  expect(await h.call("log_meal", {})).toMatchObject({ block: true });
});


it("retains a saved draft receipt after model quota exhaustion", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(draft())));
  const h = await harness("Estimate lunch"); await h.call("create_pending_meal", {}); await h.terminal("error");
  expect(h.replies[0].text).toContain("Meal draft saved for Cici");
  expect(h.replies[0].text).toContain("Check your meals and drafts before retrying");
});

it("keeps direct meal idempotency independent of model-supplied keys", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ id: "persisted-meal" })); vi.stubGlobal("fetch", fetchMock);
  const h = await harness("Log it"); await h.call("log_meal", { idempotencyKey: "model-first-key" }); await h.call("log_meal", { idempotencyKey: "model-new-key" });
  const keys = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).idempotencyKey);
  expect(keys[0]).toMatch(/^meal:[a-f0-9]{64}$/); expect(keys[1]).toBe(keys[0]);
});
