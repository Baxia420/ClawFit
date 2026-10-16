import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePendingMealScope, HealthApiNetworkError, healthFetch } from "./health-client.js";

describe("OpenClaw Health API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["/v1/nutrition/estimate", "/v1/settings"])("keeps the deadline with a caller signal: %s", async path => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token");
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const caller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const request = healthFetch({}, path, { signal: caller.signal, fetchImpl });
    const assertion = expect(request).rejects.toBeInstanceOf(HealthApiNetworkError);
    await vi.advanceTimersByTimeAsync(path.includes("estimate") ? 75_000 : 30_000);
    await assertion;
    expect(caller.signal.aborted).toBe(false);
  });

  it("honors caller cancellation before the nutrition deadline", async () => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token");
    const caller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const request = healthFetch({}, "/v1/nutrition/estimate", { signal: caller.signal, fetchImpl });
    const assertion = expect(request).rejects.toBeInstanceOf(HealthApiNetworkError);
    caller.abort();
    await assertion;
  });

  it("derives a stable, non-identifying scope from the trusted peer identity", () => {
    const first = derivePendingMealScope({ messageChannel: "whatsapp", requesterSenderId: "+60123456789", sessionKey: "session-one" });
    const afterReset = derivePendingMealScope({ messageChannel: "whatsapp", requesterSenderId: "+60123456789", sessionKey: "session-two" });
    const anotherPeer = derivePendingMealScope({ messageChannel: "whatsapp", requesterSenderId: "+60987654321", sessionKey: "session-three" });

    expect(afterReset).toBe(first);
    expect(anotherPeer).not.toBe(first);
    expect(first).toMatch(/^openclaw:whatsapp:[a-f0-9]{32}$/);
    expect(first).not.toContain("60123456789");
  });

  it("falls back to session identity when peer identity is unavailable", () => {
    expect(derivePendingMealScope({ messageChannel: "cli", sessionKey: "session-a" })).not.toBe(
      derivePendingMealScope({ messageChannel: "cli", sessionKey: "session-b" }),
    );
  });

  it("logs diagnostics but throws a typed user-safe network error", async () => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token-that-is-at-least-24-chars");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1");
    });

    const error = await healthFetch({}, "/v1/settings", { fetchImpl }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HealthApiNetworkError);
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"network_error"'));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|settings|test-token/);
  });

  it.each([429, 503])("records a privacy-safe non-success outcome for HTTP %s", async status => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-secret");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(healthFetch({}, "/v1/nutrition/estimate", {
      body: { text: "private caption", image: { base64: "private bytes" } },
      sender: { senderId: "private sender", conversationId: "private group" },
      fetchImpl: async () => Response.json({ error: { code: "PRIVATE_CODE", message: "private provider error" } }, { status }),
    })).rejects.toMatchObject({ status });
    expect(log).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(log.mock.calls[0]![0]).slice("[clawfit-api] ".length));
    expect(record).toEqual({ operation: "nutrition_estimate", reason: "http_error", status, durationMs: expect.any(Number) });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|PRIVATE|test-secret/);
  });

  it("injects sender identity and conversation headers when sender context is provided", async () => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "openclaw-token-at-least-24-chars");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await healthFetch({}, "/v1/workouts/active", {
      fetchImpl,
      sender: {
        provider: "whatsapp",
        senderId: "+60123456789",
        conversationId: "123456789@g.us",
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer openclaw-token-at-least-24-chars",
          "x-clawfit-sender-provider": "whatsapp",
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": "123456789@g.us",
        }),
      }),
    );
  });
});

it("uses an explicit household URL and returns the API's verified recipient", async () => {
  vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token");
  try {
    const fetchImpl = vi.fn().mockImplementation(async () => Response.json({ id: "meal", userId: "partner" }, { headers: { "x-clawfit-meal-recipient": encodeURIComponent(JSON.stringify({ userId: "partner", displayName: "Cici" })) } }));
    const result = await healthFetch({}, "/v1/meals", { method: "POST", sender: { senderId: "original-sender", conversationId: "authorized-group", mealFor: "Cici" }, fetchImpl });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/v1/household/meals");
    expect(result).toMatchObject({ recipient: { displayName: "Cici" } });
  } finally { vi.unstubAllEnvs(); }
});
