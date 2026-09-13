import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePendingMealScope, deriveWhatsAppNutritionOperationId, HealthApiNetworkError, healthFetch } from "./health-client.js";

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

  describe("deriveWhatsAppNutritionOperationId", () => {
    const scopeKey = "openclaw:whatsapp:test-scope";
    const commonPrefix = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/"; // 128 chars

    it("produces identical operation IDs on same-request retry", () => {
      const options = {
        scopeKey,
        text: "Chicken rice and iced tea",
        images: [{ mimeType: "image/jpeg", base64: `${commonPrefix}PhotoContentA12345` }],
      };

      const first = deriveWhatsAppNutritionOperationId(options);
      const second = deriveWhatsAppNutritionOperationId(options);

      expect(first).toBe(second);
      expect(first).toMatch(/^wa_openclaw:whatsapp:test-scope_[a-f0-9]{16}$/);
    });

    it("differentiates distinct photos that share a base64 prefix", () => {
      const photoA = `${commonPrefix}UNIQUE_TAIL_FOR_PHOTO_A_APPLES`;
      const photoB = `${commonPrefix}UNIQUE_TAIL_FOR_PHOTO_B_BANANAS`;

      const idA = deriveWhatsAppNutritionOperationId({
        scopeKey,
        text: "My lunch",
        images: [{ mimeType: "image/jpeg", base64: photoA }],
      });

      const idB = deriveWhatsAppNutritionOperationId({
        scopeKey,
        text: "My lunch",
        images: [{ mimeType: "image/jpeg", base64: photoB }],
      });

      expect(idA).not.toBe(idB);
    });

    it("hashes all images in multi-image input", () => {
      const img1 = { mimeType: "image/jpeg", base64: `${commonPrefix}FirstCourse` };
      const img2 = { mimeType: "image/jpeg", base64: `${commonPrefix}SecondCourse` };

      const singleImageId = deriveWhatsAppNutritionOperationId({
        scopeKey,
        text: "Two course dinner",
        images: [img1],
      });

      const multiImageId = deriveWhatsAppNutritionOperationId({
        scopeKey,
        text: "Two course dinner",
        images: [img1, img2],
      });

      const multiImageRetryId = deriveWhatsAppNutritionOperationId({
        scopeKey,
        text: "Two course dinner",
        images: [img1, img2],
      });

      expect(multiImageId).not.toBe(singleImageId);
      expect(multiImageId).toBe(multiImageRetryId);
    });

    it("extracts stable logical IDs from incoming messages and distinguishes different messages", () => {
      const idFromToolCall = deriveWhatsAppNutritionOperationId({
        scopeKey,
        toolContext: { toolCallId: "call_abc123" },
      });
      expect(idFromToolCall).toBe(`wa_${scopeKey}_call_abc123`);

      const idFromMsgId = deriveWhatsAppNutritionOperationId({
        scopeKey,
        toolContext: { messageId: "msg_998877" },
      });
      expect(idFromMsgId).toBe(`wa_${scopeKey}_msg_998877`);

      const idFromDeliveryCtx = deriveWhatsAppNutritionOperationId({
        scopeKey,
        toolContext: { deliveryContext: { messageId: "delivery_445566" } },
      });
      expect(idFromDeliveryCtx).toBe(`wa_${scopeKey}_delivery_445566`);

      expect(idFromMsgId).not.toBe(idFromDeliveryCtx);
    });

    it("prioritizes explicit operationId when provided", () => {
      const explicit = "explicit-custom-operation-id";
      const id = deriveWhatsAppNutritionOperationId({
        scopeKey,
        explicitOperationId: explicit,
        toolContext: { messageId: "msg_123" },
      });
      expect(id).toBe(explicit);
    });
  });
});
