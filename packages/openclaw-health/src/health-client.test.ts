import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePendingMealScope, HealthApiNetworkError, healthFetch } from "./health-client.js";

describe("OpenClaw Health API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1");
    });

    const error = await healthFetch({}, "/v1/settings", { fetchImpl }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HealthApiNetworkError);
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalledWith("[HEALTH_API_NETWORK] request failed", { path: "/v1/settings" }, expect.any(TypeError));
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
