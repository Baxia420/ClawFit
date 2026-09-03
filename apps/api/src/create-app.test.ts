import { describe, expect, it, vi } from "vitest";
import { createApp } from "./create-app.js";
import { DEFAULT_PRIMARY_USER_ID, type HealthRepository } from "@clawfit/db";

const token = "test-token-that-is-at-least-24-chars";
const repository = {
  listRecentMeals: vi.fn().mockResolvedValue([]),
  createMeal: vi.fn(),
} as unknown as HealthRepository;

describe("Health API", () => {
  it("allows the public health endpoint", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("handles the public /ready endpoint based on repository readiness", async () => {
    const readyRepo = {
      checkReady: vi.fn().mockResolvedValue(true),
    } as unknown as HealthRepository;
    const readyApp = createApp({ repository: readyRepo, apiToken: token, logger: false });
    const readyRes = await readyApp.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toEqual({ status: "ready" });
    await readyApp.close();

    const unreadyRepo = {
      checkReady: vi.fn().mockRejectedValue(new Error("Pre-0004 schema missing")),
    } as unknown as HealthRepository;
    const unreadyApp = createApp({ repository: unreadyRepo, apiToken: token, logger: false });
    const unreadyRes = await unreadyApp.inject({ method: "GET", url: "/ready" });
    expect(unreadyRes.statusCode).toBe(503);
    expect(unreadyRes.json()).toEqual({ status: "not_ready" });
    await unreadyApp.close();
  });

  it("requires bearer authentication", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "GET", url: "/v1/meals/recent" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("rejects invalid domain payloads", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "POST", url: "/v1/meals", headers: { authorization: `Bearer ${token}` }, payload: { label: "missing nutrition" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PAYLOAD");
    await app.close();
  });

  it("handles pending meal lifecycle routes", async () => {
    const validUuid = "11111111-1111-4111-a111-111111111111";
    const mealUuid = "22222222-2222-4222-a222-222222222222";
    const pendingRepo = {
      createPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      getLatestPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      getPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      updatePendingMeal: vi.fn().mockResolvedValue({ id: validUuid, label: "Two eggs", confirmed: false }),
      cancelPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, cancelledAt: new Date() }),
      confirmPendingMeal: vi.fn().mockResolvedValue({ id: mealUuid, label: "Eggs" }),
    } as unknown as HealthRepository;

    const app = createApp({ repository: pendingRepo, apiToken: token, logger: false });
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/meals/pending",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: "Eggs",
        items: [{ name: "Eggs", portionDescription: "2 eggs" }],
        calories: { best: 140, low: 130, high: 150 },
        macros: { proteinG: 12, carbsG: 1, fatG: 10, fiberG: 0 },
        confidence: "high",
        uncertaintyReasons: [],
        scopeKey: "web:primary",
        idempotencyKey: "test-pending-12345",
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().id).toBe(validUuid);

    const latestRes = await app.inject({
      method: "GET",
      url: "/v1/meals/pending/latest?scopeKey=web%3Aprimary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(latestRes.statusCode).toBe(200);
    expect(latestRes.json().pending.id).toBe(validUuid);

    const editRes = await app.inject({ method: "PATCH", url: `/v1/meals/pending/${validUuid}`, headers: { authorization: `Bearer ${token}` }, payload: { scopeKey: "web:primary", label: "Two eggs" } });
    expect(editRes.statusCode).toBe(200);
    expect(pendingRepo.updatePendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, "web:primary", { label: "Two eggs" });

    const cancelRes = await app.inject({ method: "DELETE", url: `/v1/meals/pending/${validUuid}?scopeKey=web%3Aprimary`, headers: { authorization: `Bearer ${token}` } });
    expect(cancelRes.statusCode).toBe(200);
    expect(pendingRepo.cancelPendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, "web:primary");

    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/meals/pending/${validUuid}/confirm`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scopeKey: "web:primary" },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().id).toBe(mealUuid);
    expect(pendingRepo.confirmPendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, { scopeKey: "web:primary" });

    const missingScopeRes = await app.inject({
      method: "GET",
      url: "/v1/meals/pending/latest",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingScopeRes.statusCode).toBe(400);

    await app.close();
  });

  it("validates and persists settings and notification routes", async () => {
    const settingsRepo = {
      getSettings: vi.fn().mockResolvedValue({ calorieTarget: 2200, proteinTargetG: 160, timezone: "Asia/Kuala_Lumpur", preferredUnits: "metric" }),
      updateSettings: vi.fn().mockImplementation(async (value) => value),
      listNotificationPreferences: vi.fn().mockResolvedValue([]),
      upsertNotificationPreference: vi.fn().mockImplementation(async (value) => value),
    } as unknown as HealthRepository;
    const app = createApp({ repository: settingsRepo, apiToken: token, logger: false });
    const headers = { authorization: `Bearer ${token}` };

    const settingsResponse = await app.inject({ method: "PATCH", url: "/v1/settings", headers, payload: { calorieTarget: 2400, timezone: "Asia/Kuala_Lumpur" } });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsRepo.updateSettings).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, { calorieTarget: 2400, timezone: "Asia/Kuala_Lumpur" });

    const notificationResponse = await app.inject({
      method: "PUT",
      url: "/v1/notification-preferences/daily_summary",
      headers,
      payload: { enabled: true, timeLocal: "21:30", timezone: "Asia/Kuala_Lumpur", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], deliveryChannel: "web_push", configuration: {} },
    });
    expect(notificationResponse.statusCode).toBe(200);
    expect(settingsRepo.upsertNotificationPreference).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, expect.objectContaining({ type: "daily_summary", enabled: true }));
    await app.close();
  });

  describe("Stage 2 — Secure WhatsApp User Routing & Machine Token Boundaries", () => {
    const webToken = "web-secret-token-at-least-24-chars";
    const openclawToken = "openclaw-secret-token-at-least-24-chars";
    const userA = "00000000-0000-0000-0000-000000000002";
    const userB = "00000000-0000-0000-0000-000000000003";
    const approvedGroupId = "123456789-987654@g.us";
    const unapprovedGroupId = "unapproved-group@g.us";

    const mockRepo = {
      resolveUser: vi.fn().mockImplementation(async ({ externalIdentifier }) => {
        if (externalIdentifier === "+60123456789") {
          return { resolved: true, user: { id: userA, role: "primary", active: true } };
        }
        if (externalIdentifier === "+60198765432") {
          return { resolved: true, user: { id: userB, role: "partner", active: true } };
        }
        if (externalIdentifier === "+60177778888") {
          return { resolved: false, reason: "user_inactive_or_missing" };
        }
        return { resolved: false, reason: "unknown_external_identity" };
      }),
      listRecentMeals: vi.fn().mockResolvedValue([]),
      createMeal: vi.fn().mockImplementation(async (userId, input) => ({ id: "meal-1", userId, ...input })),
    } as unknown as HealthRepository;

    const authApp = createApp({
      repository: mockRepo,
      webToken,
      openclawToken,
      allowedGroupIds: [approvedGroupId],
      logger: false,
    });

    it("allows web token requests without sender headers and binds to primary compatibility user", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userA, 20);
    });

    it("rejects web token requests that attempt to supply sender identity headers", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${webToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-sender-provider": "whatsapp",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
      expect(res.json().error.message).toContain("Sender headers not permitted for web client");
    });

    it("routes OpenClaw requests for recognized User A to User A in DMs", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": "+60123456789@s.whatsapp.net",
          "x-clawfit-sender-provider": "whatsapp",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userA, 20);
    });

    it("routes OpenClaw requests for recognized User B to User B in DMs", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60198765432",
          "x-clawfit-conversation-id": "+60198765432@s.whatsapp.net",
          "x-clawfit-sender-provider": "whatsapp",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userB, 20);
    });

    it("denies OpenClaw requests for unknown senders with a safe domain message", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60100000000",
          "x-clawfit-conversation-id": "+60100000000@s.whatsapp.net",
          "x-clawfit-sender-provider": "whatsapp",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("UNRESOLVED_SENDER_IDENTITY");
      expect(res.json().error.message).toBe("This WhatsApp account isn't linked to a ClawFit profile yet.");
    });

    it("denies OpenClaw requests for inactive senders with a safe domain message", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60177778888",
          "x-clawfit-conversation-id": "+60177778888@s.whatsapp.net",
          "x-clawfit-sender-provider": "whatsapp",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("INACTIVE_USER");
      expect(res.json().error.message).toBe("This ClawFit profile is inactive.");
    });

    it("denies OpenClaw group messages from unapproved WhatsApp groups", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": unapprovedGroupId,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("UNAUTHORIZED_GROUP");
      expect(res.json().error.message).toContain("not authorized");
    });

    it("allows OpenClaw group messages from approved WhatsApp groups with recognized senders", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": approvedGroupId,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userA, 20);
    });

    it("strictly ignores caller attempts to supply an arbitrary user ID via headers or query", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: `/v1/meals/recent?userId=${userB}`,
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": approvedGroupId,
          "x-user-id": userB,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userA, 20);
    });

    it("rejects OpenClaw user operations when sender ID header is missing", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-conversation-id": approvedGroupId,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("MISSING_SENDER_IDENTITY");
    });

    it("rejects OpenClaw user operations when conversation ID header is missing", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("MISSING_CONVERSATION_IDENTITY");
    });

    it("fails creation if webToken and openclawToken are equal", () => {
      const duplicateToken = "duplicate-token-at-least-24-chars";
      expect(() =>
        createApp({
          repository: mockRepo,
          webToken: duplicateToken,
          openclawToken: duplicateToken,
          logger: false,
        }),
      ).toThrow("HEALTH_API_WEB_TOKEN and HEALTH_API_OPENCLAW_TOKEN must be configured and different from each other");
    });

    it("fails closed with 500 error if request.userId is missing rather than defaulting to Primary User", async () => {
      const isolatedRepo: any = {
        listRecentMeals: vi.fn().mockResolvedValue([]),
      };
      const brokenAuthApp = createApp({
        repository: isolatedRepo,
        webToken,
        openclawToken,
        logger: false,
      });
      // Add a test hook that clears userId after authentication to verify fail-closed invariant
      brokenAuthApp.addHook("preHandler", async (request) => {
        request.userId = undefined;
      });

      const res = await brokenAuthApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(res.statusCode).toBe(500);
      expect(isolatedRepo.listRecentMeals).not.toHaveBeenCalled();
      await brokenAuthApp.close();
    });
  });
});

