import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createApp } from "./create-app.js";
import { DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID, type HealthRepository, NotFoundError } from "@clawfit/db";

const webToken = "test-token-that-is-at-least-24-chars";
const openclawToken = "openclaw-test-token-at-least-24-chars";
const assertionSecret = "web-assertion-signing-secret-at-least-32-chars";

let validWebAssertion: string;
const makeWebAssertion = async (
  userId = DEFAULT_PRIMARY_USER_ID,
  secret = assertionSecret,
  issuer = "clawfit-web",
  audience = "clawfit-health-api",
  expiresIn = "1m",
) => {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
};

const repository = {
  getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true, displayName: "Primary User", role: "primary" }),
  listRecentMeals: vi.fn().mockResolvedValue([]),
  createMeal: vi.fn(),
} as unknown as HealthRepository;

describe("Health API", () => {
  beforeAll(async () => {
    validWebAssertion = await makeWebAssertion();
  });
  it("allows the public health endpoint", async () => {
    const app = createApp({ repository, webToken, openclawToken, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("handles the public /ready endpoint based on repository readiness", async () => {
    const readyRepo = {
      checkReady: vi.fn().mockResolvedValue(true),
    } as unknown as HealthRepository;
    const readyApp = createApp({ repository: readyRepo, webToken, openclawToken, logger: false });
    const readyRes = await readyApp.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toEqual({
      status: "ready",
      database: "ok",
      schema: "ok",
      estimator: "unconfigured",
    });
    await readyApp.close();

    const readyAppWithEstimator = createApp({
      repository: readyRepo,
      webToken,
      openclawToken,
      estimator: { estimate: vi.fn() } as unknown as any,
      logger: false,
    });
    const readyWithEstimatorRes = await readyAppWithEstimator.inject({ method: "GET", url: "/ready" });
    expect(readyWithEstimatorRes.statusCode).toBe(200);
    expect(readyWithEstimatorRes.json()).toEqual({
      status: "ready",
      database: "ok",
      schema: "ok",
      estimator: "configured",
    });
    await readyAppWithEstimator.close();

    const unreadyRepo = {
      checkReady: vi.fn().mockRejectedValue(new Error("Pre-0004 schema missing")),
    } as unknown as HealthRepository;
    const unreadyApp = createApp({ repository: unreadyRepo, webToken, openclawToken, logger: false });
    const unreadyRes = await unreadyApp.inject({ method: "GET", url: "/ready" });
    expect(unreadyRes.statusCode).toBe(503);
    expect(unreadyRes.json()).toEqual({ status: "not_ready" });
    await unreadyApp.close();
  });

  it("requires bearer authentication", async () => {
    const app = createApp({ repository, webToken, openclawToken, logger: false });
    const response = await app.inject({ method: "GET", url: "/v1/meals/recent" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("rejects invalid domain payloads", async () => {
    const app = createApp({ repository, webToken, openclawToken, assertionSecret, logger: false });
    const response = await app.inject({ method: "POST", url: "/v1/meals", headers: { authorization: `Bearer ${validWebAssertion}` }, payload: { label: "missing nutrition" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PAYLOAD");
    await app.close();
  });

  it("handles pending meal lifecycle routes", async () => {
    const validUuid = "11111111-1111-4111-a111-111111111111";
    const mealUuid = "22222222-2222-4222-a222-222222222222";
    const pendingRepo = {
      getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true, displayName: "Primary User", role: "primary" }),
      createPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      listPendingMeals: vi.fn().mockResolvedValue([{ id: validUuid, confirmed: false }]),
      getLatestPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      getPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, confirmed: false }),
      updatePendingMeal: vi.fn().mockResolvedValue({ id: validUuid, label: "Two eggs", confirmed: false }),
      cancelPendingMeal: vi.fn().mockResolvedValue({ id: validUuid, cancelledAt: new Date() }),
      confirmPendingMeal: vi.fn().mockResolvedValue({ id: mealUuid, label: "Eggs" }),
    } as unknown as HealthRepository;

    const app = createApp({ repository: pendingRepo, webToken, openclawToken, assertionSecret, logger: false });
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/meals/pending",
      headers: { authorization: `Bearer ${validWebAssertion}` },
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

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/meals/pending?scopeKey=web%3Aprimary",
      headers: { authorization: `Bearer ${validWebAssertion}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().pending).toHaveLength(1);
    expect(pendingRepo.listPendingMeals).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, "web:primary", undefined, 20);

    const latestRes = await app.inject({
      method: "GET",
      url: "/v1/meals/pending/latest?scopeKey=web%3Aprimary",
      headers: { authorization: `Bearer ${validWebAssertion}` },
    });
    expect(latestRes.statusCode).toBe(200);
    expect(latestRes.json().pending.id).toBe(validUuid);

    const editRes = await app.inject({ method: "PATCH", url: `/v1/meals/pending/${validUuid}`, headers: { authorization: `Bearer ${validWebAssertion}` }, payload: { scopeKey: "web:primary", label: "Two eggs" } });
    expect(editRes.statusCode).toBe(200);
    expect(pendingRepo.updatePendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, "web:primary", { label: "Two eggs" });

    const cancelRes = await app.inject({ method: "DELETE", url: `/v1/meals/pending/${validUuid}?scopeKey=web%3Aprimary`, headers: { authorization: `Bearer ${validWebAssertion}` } });
    expect(cancelRes.statusCode).toBe(200);
    expect(pendingRepo.cancelPendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, "web:primary");

    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/meals/pending/${validUuid}/confirm`,
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: { scopeKey: "web:primary" },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().id).toBe(mealUuid);
    expect(pendingRepo.confirmPendingMeal).toHaveBeenCalledWith(DEFAULT_PRIMARY_USER_ID, validUuid, { scopeKey: "web:primary" });

    const missingScopeRes = await app.inject({
      method: "GET",
      url: "/v1/meals/pending/latest",
      headers: { authorization: `Bearer ${validWebAssertion}` },
    });
    expect(missingScopeRes.statusCode).toBe(400);

    await app.close();
  });

  it("supports multi-image nutrition estimation and returns estimator metadata", async () => {
    const mockEstimator = {
      estimate: vi.fn().mockResolvedValue({
        estimate: {
          label: "Protein bar",
          calories: { best: 210, low: 200, high: 220 },
          macros: { proteinG: 20, carbsG: 22, fatG: 7, fiberG: 10 },
          confidence: "high",
          uncertaintyReasons: [],
        },
        model: "gemini-3.8-flash",
        fallbackUsed: false,
      }),
    };
    const app = createApp({
      repository,
      webToken,
      openclawToken,
      assertionSecret,
      estimator: mockEstimator as any,
      logger: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/nutrition/estimate",
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: {
        text: "Protein bar package and label",
        images: [
          { mimeType: "image/jpeg", base64: "dGVzdC1wYWNrYWdl" },
          { mimeType: "image/jpeg", base64: "dGVzdC1udXRyaXRpb24tbGFiZWw=" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("Protein bar");
    expect(res.json().estimatorModelId).toBe("gemini-3.8-flash");
    expect(res.json().fallbackUsed).toBe(false);
    expect(res.json().correlationId).toBeDefined();
    expect(mockEstimator.estimate).toHaveBeenCalledWith({
      text: "Protein bar package and label",
      images: [
        { mimeType: "image/jpeg", base64: "dGVzdC1wYWNrYWdl" },
        { mimeType: "image/jpeg", base64: "dGVzdC1udXRyaXRpb24tbGFiZWw=" },
      ],
    });
    await app.close();
  });

  it("proves daily-total query does not invoke the nutrition estimator", async () => {
    const mockEstimator = { estimate: vi.fn() };
    const mockRepo = {
      getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
      dailyNutrition: vi.fn().mockResolvedValue({ date: "2026-09-08", totals: { caloriesBest: 1490 }, meals: [] }),
    } as unknown as HealthRepository;

    const app = createApp({ repository: mockRepo, webToken, openclawToken, assertionSecret, estimator: mockEstimator as any, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/nutrition/daily?date=2026-09-08&timezone=Asia/Kuala_Lumpur",
      headers: { authorization: `Bearer ${validWebAssertion}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEstimator.estimate).not.toHaveBeenCalled();
    await app.close();
  });

  it("proves confirming an existing draft does not rerun nutrition estimation", async () => {
    const mockEstimator = { estimate: vi.fn() };
    const mockRepo = {
      getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
      confirmPendingMeal: vi.fn().mockResolvedValue({ id: "meal-uuid", label: "Confirmed Eggs" }),
    } as unknown as HealthRepository;

    const app = createApp({ repository: mockRepo, webToken, openclawToken, assertionSecret, estimator: mockEstimator as any, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/meals/pending/11111111-1111-4111-a111-111111111111/confirm",
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: { scopeKey: "web:primary" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEstimator.estimate).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a realistic multi-image payload (~2 MiB) on /v1/nutrition/estimate", async () => {
    const mockEstimator = {
      estimate: vi.fn().mockResolvedValue({
        estimate: { label: "Multi-photo meal", calories: { best: 500, low: 450, high: 550 }, macros: { proteinG: 30, carbsG: 40, fatG: 20, fiberG: 5 }, confidence: "high", uncertaintyReasons: [] },
        model: "gemini-3.8-flash",
        fallbackUsed: false,
      }),
    };
    const app = createApp({ repository, webToken, openclawToken, assertionSecret, estimator: mockEstimator as any, logger: false });
    // 2 MiB string base64 payload
    const twoMbBase64 = "a".repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/nutrition/estimate",
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: {
        text: "Two photos",
        images: [{ mimeType: "image/jpeg", base64: twoMbBase64 }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEstimator.estimate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects an oversized payload exceeding the 16 MiB budget on /v1/nutrition/estimate with 413", async () => {
    const mockEstimator = { estimate: vi.fn() };
    const app = createApp({ repository, webToken, openclawToken, assertionSecret, estimator: mockEstimator as any, logger: false });
    // 17 MiB payload exceeding the 16 MiB route budget
    const oversizedPayload = "a".repeat(17 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/nutrition/estimate",
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: { text: oversizedPayload },
    });

    expect(res.statusCode).toBe(413);
    expect(mockEstimator.estimate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an oversized payload exceeding 1 MiB on standard routes (e.g. /v1/meals) with 413", async () => {
    const app = createApp({ repository, webToken, openclawToken, assertionSecret, logger: false });
    // 1.5 MiB payload exceeding the 1 MiB default budget
    const oversizedPayload = "a".repeat(1536 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/meals",
      headers: { authorization: `Bearer ${validWebAssertion}` },
      payload: { label: oversizedPayload, items: [], caloriesBest: 500, occurredAt: new Date().toISOString(), source: "manual", rawUserText: null, idempotencyKey: "123" },
    });

    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("validates and persists settings and notification routes", async () => {
    const settingsRepo = {
      getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
      getSettings: vi.fn().mockResolvedValue({ calorieTarget: 2200, proteinTargetG: 160, timezone: "Asia/Kuala_Lumpur", preferredUnits: "metric" }),
      updateSettings: vi.fn().mockImplementation(async (value) => value),
      listNotificationPreferences: vi.fn().mockResolvedValue([]),
      upsertNotificationPreference: vi.fn().mockImplementation(async (value) => value),
    } as unknown as HealthRepository;
    const app = createApp({ repository: settingsRepo, webToken, openclawToken, assertionSecret, logger: false });
    const headers = { authorization: `Bearer ${validWebAssertion}` };

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
      getUser: vi.fn().mockImplementation(async (id: string) => {
        if (id === userA) return { id: userA, role: "primary", active: true, displayName: "User A" };
        if (id === userB) return { id: userB, role: "partner", active: true, displayName: "User B" };
        return null;
      }),
      listRecentMeals: vi.fn().mockResolvedValue([]),
      createMeal: vi.fn().mockImplementation(async (userId, input) => ({ id: "meal-1", userId, ...input })),
    } as unknown as HealthRepository;

    const authApp = createApp({
      repository: mockRepo,
      webToken,
      openclawToken,
      assertionSecret,
      allowedGroupIds: [approvedGroupId],
      logger: false,
    });

    it("rejects web machine token requests on health routes without a signed user assertion", async () => {
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      expect(res.json().error.message).toContain("signed user assertion is required");
      expect(mockRepo.listRecentMeals).not.toHaveBeenCalled();
    });

    it("allows valid signed web assertion requests for User A", async () => {
      const assertion = await makeWebAssertion(userA, assertionSecret);
      const res = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${assertion}` },
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

    it("strictly ignores caller attempts to supply an arbitrary user ID via query and rejects spoofed headers", async () => {
      const resQuery = await authApp.inject({
        method: "GET",
        url: `/v1/meals/recent?userId=${userB}`,
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": approvedGroupId,
        },
      });
      expect(resQuery.statusCode).toBe(200);
      expect(mockRepo.listRecentMeals).toHaveBeenCalledWith(userA, 20);

      const resSpoof = await authApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
          "x-clawfit-conversation-id": approvedGroupId,
          "x-user-id": userB,
        },
      });
      expect(resSpoof.statusCode).toBe(403);
      expect(resSpoof.json().error.code).toBe("FORBIDDEN");
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

    it("rejects OpenClaw /v1/nutrition/estimate requests lacking conversation identity", async () => {
      const res = await authApp.inject({
        method: "POST",
        url: "/v1/nutrition/estimate",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-sender-id": "+60123456789",
        },
        payload: { text: "2 eggs" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("MISSING_CONVERSATION_IDENTITY");
    });

    it("rejects OpenClaw /v1/nutrition/estimate requests lacking sender identity", async () => {
      const res = await authApp.inject({
        method: "POST",
        url: "/v1/nutrition/estimate",
        headers: {
          authorization: `Bearer ${openclawToken}`,
          "x-clawfit-conversation-id": approvedGroupId,
        },
        payload: { text: "2 eggs" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("MISSING_SENDER_IDENTITY");
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
        getUser: vi.fn().mockResolvedValue({ id: userA, active: true }),
        listRecentMeals: vi.fn().mockResolvedValue([]),
      };
      const brokenAuthApp = createApp({
        repository: isolatedRepo,
        webToken,
        openclawToken,
        assertionSecret,
        logger: false,
      });
      // Add a test hook that clears userId after authentication to verify fail-closed invariant
      brokenAuthApp.addHook("preHandler", async (request) => {
        request.userId = undefined;
      });

      const assertion = await makeWebAssertion(userA, assertionSecret);
      const res = await brokenAuthApp.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${assertion}` },
      });
      expect(res.statusCode).toBe(500);
      expect(isolatedRepo.listRecentMeals).not.toHaveBeenCalled();
      await brokenAuthApp.close();
    });

    it("restores nutrition API contract envelope with estimate, model, fallbackUsed, estimatorModelId, and correlationId", async () => {
      const mockEstimator = {
        estimate: vi.fn().mockResolvedValue({
          estimate: {
            label: "Two poached eggs on sourdough toast",
            items: [
              { name: "Poached eggs", portionDescription: "2 eggs" },
              { name: "Sourdough toast", portionDescription: "2 slices" },
            ],
            calories: { best: 350, low: 320, high: 380 },
            macros: { proteinG: 20, carbsG: 34, fatG: 14, fiberG: 3 },
            confidence: "high" as const,
            uncertaintyReasons: [],
          },
          model: "gemini-3.8-flash",
          fallbackUsed: false,
        }),
      };

      const testRepo = {
        getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
        createPendingMeal: vi.fn(),
      } as unknown as HealthRepository;

      const app = createApp({
        repository: testRepo,
        webToken,
        openclawToken,
        assertionSecret,
        estimator: mockEstimator as any,
        logger: false,
      });

      const assertion = await makeWebAssertion(DEFAULT_PRIMARY_USER_ID, assertionSecret);
      const res = await app.inject({
        method: "POST",
        url: "/v1/nutrition/estimate",
        headers: { authorization: `Bearer ${assertion}` },
        payload: { text: "two poached eggs on sourdough toast" },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.estimate).toBeDefined();
      expect(json.estimate.label).toBe("Two poached eggs on sourdough toast");
      expect(json.estimate.calories.best).toBe(350);
      expect(json.estimate.macros.proteinG).toBe(20);
      expect(json.estimate.confidence).toBe("high");
      expect(json.model).toBe("gemini-3.8-flash");
      expect(json.estimatorModelId).toBe("gemini-3.8-flash");
      expect(json.fallbackUsed).toBe(false);
      expect(json.label).toBe("Two poached eggs on sourdough toast");
      expect(json.calories.best).toBe(350);

      await app.close();
    });
  });

  describe("Phase 4 Increment 1 — Web Identity, Signed Assertions, and Account Linking", () => {
    const primaryEmail = "primary@example.com";
    const partnerEmail = "partner@example.com";
    const appSecret = "super-secret-auth-key-at-least-32-chars";

    const makeTestAssertion = async (
      userId: string,
      options?: {
        secret?: string;
        issuer?: string;
        audience?: string;
        issuedAt?: number;
        expiresIn?: string | number;
        alg?: string;
        omitClaim?: "sub" | "iss" | "aud" | "iat" | "exp";
      },
    ) => {
      const alg = options?.alg ?? "HS256";
      const payload: Record<string, unknown> = {};
      if (options?.omitClaim !== "sub") {
        payload.sub = userId;
      }
      const jwt = new SignJWT(payload).setProtectedHeader({ alg });
      if (options?.omitClaim !== "iss") {
        jwt.setIssuer(options?.issuer ?? "clawfit-web");
      }
      if (options?.omitClaim !== "aud") {
        jwt.setAudience(options?.audience ?? "clawfit-health-api");
      }
      if (options?.omitClaim !== "iat") {
        if (options?.issuedAt !== undefined) {
          jwt.setIssuedAt(options.issuedAt);
        } else {
          jwt.setIssuedAt();
        }
      }
      if (options?.omitClaim !== "exp") {
        if (options?.expiresIn !== undefined) {
          jwt.setExpirationTime(options.expiresIn);
        } else {
          jwt.setExpirationTime("60s");
        }
      }
      return jwt.sign(new TextEncoder().encode(options?.secret ?? appSecret));
    };

    const mockPhase4Repo = {
      getUser: vi.fn().mockImplementation(async (id: string) => {
        if (id === DEFAULT_PRIMARY_USER_ID) return { id: DEFAULT_PRIMARY_USER_ID, role: "primary", active: true, displayName: "Primary User" };
        if (id === DEFAULT_PARTNER_USER_ID) return { id: DEFAULT_PARTNER_USER_ID, role: "partner", active: true, displayName: "Partner User" };
        if (id === "inactive-user-id") return { id: "inactive-user-id", role: "primary", active: false, displayName: "Inactive User" };
        return null;
      }),
      resolveUser: vi.fn().mockImplementation(async ({ provider, externalIdentifier }) => {
        if (provider === "google" && externalIdentifier === "existing-google-sub") {
          return { resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, role: "primary", active: true } };
        }
        if (provider === "google" && externalIdentifier === "inactive-google-sub") {
          return { resolved: false, reason: "user_inactive_or_missing" };
        }
        return { resolved: false, reason: "unknown_external_identity" };
      }),
      linkExternalIdentity: vi.fn().mockResolvedValue({ id: "identity-123" }),
      listRecentMeals: vi.fn().mockResolvedValue([]),
    } as unknown as HealthRepository;

    const p4App = createApp({
      repository: mockPhase4Repo,
      webToken,
      openclawToken,
      assertionSecret: appSecret,
      primaryGoogleEmail: primaryEmail,
      partnerGoogleEmail: partnerEmail,
      logger: false,
    });

    it("includes Cache-Control no-store headers on sensitive health endpoints", async () => {
      const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${assertion}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
    });

    it("proves the machine token cannot be used as an assertion-signing key", async () => {
      const signedWithMachineToken = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { secret: webToken });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${signedWithMachineToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    it("rejects machine token alone on user health routes with 401 Unauthorized", async () => {
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      expect(res.json().error.message).toContain("signed user assertion is required");
    });

    it("rejects expired web assertions with 401", async () => {
      const expiredAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, {
        issuedAt: Math.floor(Date.now() / 1000) - 120,
        expiresIn: Math.floor(Date.now() / 1000) - 60,
      });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${expiredAssertion}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    it("rejects assertions with excessive lifetime over 60 seconds with 401", async () => {
      const now = Math.floor(Date.now() / 1000);
      const excessiveAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, {
        issuedAt: now,
        expiresIn: now + 61,
      });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${excessiveAssertion}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      expect(res.json().error.message).toContain("EXCESSIVE_LIFETIME");

      // Test 10-year lifetime rejection
      const tenYearAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, {
        issuedAt: now,
        expiresIn: now + 315360000,
      });
      const res10yr = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${tenYearAssertion}` },
      });
      expect(res10yr.statusCode).toBe(401);
      expect(res10yr.json().error.code).toBe("UNAUTHORIZED");
    });

    it("rejects assertions with unsupported algorithms with 401", async () => {
      const hs512Assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { alg: "HS512" });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${hs512Assertion}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    it("rejects assertions issued excessively in the future with 401", async () => {
      const now = Math.floor(Date.now() / 1000);
      const futureAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, {
        issuedAt: now + 60,
        expiresIn: now + 100,
      });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${futureAssertion}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      expect(res.json().error.message).toContain("FUTURE_ISSUED");
    });

    it("accepts assertions with slight clock skew within 5 seconds tolerance", async () => {
      const now = Math.floor(Date.now() / 1000);
      const skewAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, {
        issuedAt: now + 3,
        expiresIn: now + 30,
      });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${skewAssertion}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects assertions missing required claims (sub, iss, aud, iat, exp)", async () => {
      for (const claim of ["sub", "iss", "aud", "iat", "exp"] as const) {
        const badAssertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { omitClaim: claim });
        const res = await p4App.inject({
          method: "GET",
          url: "/v1/meals/recent",
          headers: { authorization: `Bearer ${badAssertion}` },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe("UNAUTHORIZED");
      }
    });

    it("rejects assertions with invalid issuer or audience with 401", async () => {
      const badIssuer = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { issuer: "wrong-issuer" });
      const res1 = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${badIssuer}` },
      });
      expect(res1.statusCode).toBe(401);

      const badAudience = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { audience: "wrong-audience" });
      const res2 = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${badAudience}` },
      });
      expect(res2.statusCode).toBe(401);
    });

    it("rejects assertions signed with the wrong secret with 401", async () => {
      const wrongSecret = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID, { secret: "wrong-secret-that-does-not-match-at-all" });
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${wrongSecret}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects assertions for inactive users with 403", async () => {
      const inactiveAssertion = await makeTestAssertion("inactive-user-id");
      const res = await p4App.inject({
        method: "GET",
        url: "/v1/meals/recent",
        headers: { authorization: `Bearer ${inactiveAssertion}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("INACTIVE_USER");
    });

    describe("POST /v1/auth/google/resolve-or-link", () => {
      it("requires machine bearer token", async () => {
        const resNoAuth = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          payload: { providerAccountId: "sub-1", email: primaryEmail, emailVerified: true },
        });
        expect(resNoAuth.statusCode).toBe(401);

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const resAssertion = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${assertion}` },
          payload: { providerAccountId: "sub-1", email: primaryEmail, emailVerified: true },
        });
        expect(resAssertion.statusCode).toBe(401);
      });

      it("rejects unverified Google email with 403 UNVERIFIED_EMAIL", async () => {
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "sub-1", email: primaryEmail, emailVerified: false },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("UNVERIFIED_EMAIL");

        // Malformed non-boolean emailVerified
        const resMalformed = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "sub-1", email: primaryEmail, emailVerified: "true" },
        });
        expect(resMalformed.statusCode).toBe(403);
      });

      it("rejects unapproved email with 403 UNAPPROVED_ACCOUNT even if subject was previously linked", async () => {
        // Linked account whose email is no longer on the approved list
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "existing-google-sub", email: "unapproved@random.org", emailVerified: true },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("UNAPPROVED_ACCOUNT");
      });

      it("rejects approved email paired with Google subject bound to different user profile with 403 ACCOUNT_MISMATCH", async () => {
        // existing-google-sub is bound to Primary User, but incoming email is partnerEmail
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "existing-google-sub", email: partnerEmail, emailVerified: true },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("ACCOUNT_MISMATCH");
      });

      it("fails closed with 403 CONFIGURATION_ERROR if primary and partner emails are identical or missing", async () => {
        const brokenApp = createApp({
          repository: mockPhase4Repo,
          webToken,
          assertionSecret: appSecret,
          primaryGoogleEmail: "same@example.com",
          partnerGoogleEmail: "same@example.com",
          logger: false,
        });

        const res = await brokenApp.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "sub-1", email: "same@example.com", emailVerified: true },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("CONFIGURATION_ERROR");

        const unconfiguredApp = createApp({
          repository: mockPhase4Repo,
          webToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const resUnconfigured = await unconfiguredApp.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "sub-1", email: primaryEmail, emailVerified: true },
        });
        expect(resUnconfigured.statusCode).toBe(403);
        expect(resUnconfigured.json().error.code).toBe("CONFIGURATION_ERROR");
      });

      it("resolves an already linked Google user matching expected profile", async () => {
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "existing-google-sub", email: primaryEmail, emailVerified: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().user.id).toBe(DEFAULT_PRIMARY_USER_ID);
        expect(res.json().user.role).toBe("primary");
        expect(res.json().linked).toBe(false);
      });

      it("links Google identity to primary user when email matches primary", async () => {
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "new-primary-sub", email: primaryEmail, emailVerified: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().user.id).toBe(DEFAULT_PRIMARY_USER_ID);
        expect(res.json().user.role).toBe("primary");
        expect(res.json().linked).toBe(true);
        expect(mockPhase4Repo.linkExternalIdentity).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: DEFAULT_PRIMARY_USER_ID,
            provider: "google",
            externalIdentifier: "new-primary-sub",
          }),
        );
      });

      it("links Google identity to partner user when email matches partner", async () => {
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "new-partner-sub", email: partnerEmail, emailVerified: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().user.id).toBe(DEFAULT_PARTNER_USER_ID);
        expect(res.json().user.role).toBe("partner");
        expect(res.json().linked).toBe(true);
        expect(mockPhase4Repo.linkExternalIdentity).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: DEFAULT_PARTNER_USER_ID,
            provider: "google",
            externalIdentifier: "new-partner-sub",
          }),
        );
      });

      it("handles concurrent first-link attempts with deterministic success without leaking raw DB errors", async () => {
        let resolveAttempts = 0;
        const linkMock = vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint 'external_identities_pkey'"));
        const resolveMock = vi.fn().mockImplementation(async ({ provider, externalIdentifier }) => {
          if (provider === "google" && externalIdentifier === "racing-google-sub") {
            resolveAttempts++;
            // First call: account is not yet resolved, triggering insertion attempt
            if (resolveAttempts === 1) {
              return { resolved: false, reason: "unknown_external_identity" };
            }
            // Second call (post-conflict recovery): concurrent request succeeded in creating the link
            return { resolved: true, user: { id: DEFAULT_PRIMARY_USER_ID, role: "primary", active: true } };
          }
          return { resolved: false, reason: "unknown_external_identity" };
        });

        const concurrentRepo = {
          ...mockPhase4Repo,
          linkExternalIdentity: linkMock,
          resolveUser: resolveMock,
        } as unknown as HealthRepository;

        const racingApp = createApp({
          repository: concurrentRepo,
          webToken,
          assertionSecret: appSecret,
          primaryGoogleEmail: primaryEmail,
          partnerGoogleEmail: partnerEmail,
          logger: false,
        });

        const res = await racingApp.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "racing-google-sub", email: primaryEmail, emailVerified: true },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().resolved).toBe(true);
        expect(res.json().user.id).toBe(DEFAULT_PRIMARY_USER_ID);
        expect(linkMock).toHaveBeenCalledTimes(1);
        expect(resolveAttempts).toBe(2);
        await racingApp.close();
      });

      it("handles unsuccessful concurrency recovery with sanitized 409 error without leaking raw DB errors", async () => {
        const linkMock = vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint 'external_identities_pkey'"));
        const resolveMock = vi.fn().mockResolvedValue({ resolved: false, reason: "unknown_external_identity" });

        const concurrentRepo = {
          ...mockPhase4Repo,
          linkExternalIdentity: linkMock,
          resolveUser: resolveMock,
        } as unknown as HealthRepository;

        const racingApp = createApp({
          repository: concurrentRepo,
          webToken,
          assertionSecret: appSecret,
          primaryGoogleEmail: primaryEmail,
          partnerGoogleEmail: partnerEmail,
          logger: false,
        });

        const res = await racingApp.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "unresolved-conflict-sub", email: primaryEmail, emailVerified: true },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("IDENTITY_CONFLICT");
        expect(res.json().error.message).toBe("The Google account could not be linked due to an unresolved identity conflict");
        expect(res.json().error.message).not.toContain("duplicate key");
        expect(linkMock).toHaveBeenCalledTimes(1);
        expect(resolveMock).toHaveBeenCalledTimes(2);
        await racingApp.close();
      });

      it("handles unexpected DB failure during recovery with sanitized 500 error", async () => {
        let callCount = 0;
        const linkMock = vi.fn().mockRejectedValue(new Error("deadlock detected"));
        const resolveMock = vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return { resolved: false, reason: "unknown_external_identity" };
          throw new Error("connection terminated unexpectedly");
        });

        const concurrentRepo = {
          ...mockPhase4Repo,
          linkExternalIdentity: linkMock,
          resolveUser: resolveMock,
        } as unknown as HealthRepository;

        const racingApp = createApp({
          repository: concurrentRepo,
          webToken,
          assertionSecret: appSecret,
          primaryGoogleEmail: primaryEmail,
          partnerGoogleEmail: partnerEmail,
          logger: false,
        });

        const res = await racingApp.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "db-error-sub", email: primaryEmail, emailVerified: true },
        });

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe("INTERNAL_ERROR");
        expect(res.json().error.message).toBe("An unexpected error occurred while verifying the account link");
        expect(res.json().error.message).not.toContain("connection terminated");
        await racingApp.close();
      });

      it("rejects inactive users trying to authenticate via Google", async () => {
        const res = await p4App.inject({
          method: "POST",
          url: "/v1/auth/google/resolve-or-link",
          headers: { authorization: `Bearer ${webToken}` },
          payload: { providerAccountId: "inactive-google-sub", email: primaryEmail, emailVerified: true },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("INACTIVE_USER");
      });
    });

    describe("GET /v1/nutrition/trend", () => {
      it("uses user stored timezone and computes calendar day window boundaries", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur", calorieTarget: 2200, proteinTargetG: 160 }),
          nutritionTrend: vi.fn().mockResolvedValue([
            { day: "2026-09-10", calories_best: 300, calories_low: 270, calories_high: 330, protein_g: 30 },
            { day: "2026-09-11", calories_best: 300, calories_low: 270, calories_high: 330, protein_g: 30 },
          ]),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/nutrition/trend?days=7&date=2026-09-11",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data).toHaveLength(2);
        expect(data[0].day).toBe("2026-09-10");
        expect(data[1].day).toBe("2026-09-11");

        expect(testRepo.nutritionTrend).toHaveBeenCalledWith(
          DEFAULT_PRIMARY_USER_ID,
          new Date("2026-09-04T16:00:00.000Z"),
          new Date("2026-09-11T16:00:00.000Z"),
          "Asia/Kuala_Lumpur",
        );

        await app.close();
      });

      it("respects explicit timezone query parameter over stored settings", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          nutritionTrend: vi.fn().mockResolvedValue([]),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/nutrition/trend?days=30&date=2026-09-11&timezone=UTC",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(200);
        expect(testRepo.nutritionTrend).toHaveBeenCalledWith(
          DEFAULT_PRIMARY_USER_ID,
          new Date("2026-08-13T00:00:00.000Z"),
          new Date("2026-09-12T00:00:00.000Z"),
          "UTC",
        );

        await app.close();
      });
    });

    describe("GET /v1/together", () => {
      const appSecret = "web-assertion-signing-secret-at-least-32-chars";
      const makeTestAssertion = async (userId: string) => {
        return new SignJWT({ sub: userId })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("clawfit-web")
          .setAudience("clawfit-health-api")
          .setIssuedAt()
          .setExpirationTime("1m")
          .sign(new TextEncoder().encode(appSecret));
      };

      it("returns together dashboard data for active household member", async () => {
        const mockTogetherData = {
          household: { id: "00000000-0000-0000-0000-000000000001", name: "ClawFit Household" },
          date: "2026-09-11",
          timezone: "Asia/Kuala_Lumpur",
          members: [
            {
              userId: DEFAULT_PRIMARY_USER_ID,
              displayName: "Primary User",
              isCaller: true,
              goals: { calorieTarget: 2200, proteinTargetG: 160 },
              daily: {
                date: "2026-09-11",
                calories: 1800,
                proteinG: 140,
                mealCount: 3,
                meals: [
                  {
                    id: "00000000-0000-0000-0000-000000000010",
                    label: "Breakfast",
                    caloriesBest: 500,
                    proteinG: 30,
                    occurredAt: "2026-09-11T01:00:00.000Z",
                  },
                ],
                workouts: [
                  {
                    id: "00000000-0000-0000-0000-000000000020",
                    name: "Leg Day",
                    startedAt: "2026-09-11T02:00:00.000Z",
                    finishedAt: "2026-09-11T03:00:00.000Z",
                    setCount: 12,
                    volumeKg: 3500,
                    exercises: [
                      { id: "00000000-0000-0000-0000-000000000030", name: "Squats", setCount: 4 },
                    ],
                  },
                ],
              },
              trend: [{ day: "2026-09-11", calories: 1800, proteinG: 140 }],
            },
            {
              userId: DEFAULT_PARTNER_USER_ID,
              displayName: "Partner User",
              isCaller: false,
              goals: { calorieTarget: 1900, proteinTargetG: 130 },
              daily: {
                date: "2026-09-11",
                calories: 1600,
                proteinG: 110,
                mealCount: 2,
                meals: [],
                workouts: [],
              },
              trend: [{ day: "2026-09-11", calories: 1600, proteinG: 110 }],
            },
          ],
        };

        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn().mockResolvedValue(mockTogetherData),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/together?date=2026-09-11&days=7",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.household.name).toBe("ClawFit Household");
        expect(body.members).toHaveLength(2);
        expect(body.members[0].isCaller).toBe(true);
        expect(body.members[1].isCaller).toBe(false);

        expect(testRepo.getTogetherDashboardData).toHaveBeenCalledWith(
          DEFAULT_PRIMARY_USER_ID,
          "2026-09-11",
          "Asia/Kuala_Lumpur",
          7,
        );

        await app.close();
      });

      it("returns 403 when caller is inactive", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: false }),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/together",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("INACTIVE_USER");
        await app.close();
      });

      it("returns 403 when caller does not belong to any household", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn().mockResolvedValue(null),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/together",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("NO_HOUSEHOLD");
        await app.close();
      });

      it("rejects impossible calendar dates with HTTP 400", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn(),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);

        // 2026-02-30 is impossible
        const res1 = await app.inject({
          method: "GET",
          url: "/v1/together?date=2026-02-30",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res1.statusCode).toBe(400);
        expect(res1.json().error.code).toBe("INVALID_PAYLOAD");

        // 2026-13-01 is impossible month
        const res2 = await app.inject({
          method: "GET",
          url: "/v1/together?date=2026-13-01",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res2.statusCode).toBe(400);
        expect(res2.json().error.code).toBe("INVALID_PAYLOAD");

        // non-date string
        const res3 = await app.inject({
          method: "GET",
          url: "/v1/together?date=not-a-date",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res3.statusCode).toBe(400);

        // Repository should not be called on validation failures
        expect(testRepo.getTogetherDashboardData).not.toHaveBeenCalled();

        await app.close();
      });

      it("rejects invalid IANA timezones with HTTP 400", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn(),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/together?timezone=Invalid/Zone",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("INVALID_PAYLOAD");
        expect(testRepo.getTogetherDashboardData).not.toHaveBeenCalled();

        await app.close();
      });

      it("constrains trend days to 7 or 30 with HTTP 400 for other values", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn().mockResolvedValue({
            household: { id: "h-1", name: "House" },
            date: "2024-02-29",
            timezone: "Asia/Kuala_Lumpur",
            members: [],
          }),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);

        // days=15 is invalid
        const res15 = await app.inject({
          method: "GET",
          url: "/v1/together?days=15",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res15.statusCode).toBe(400);
        expect(res15.json().error.code).toBe("INVALID_PAYLOAD");

        // days=30 is valid, and 2024-02-29 is a valid leap day
        const res30 = await app.inject({
          method: "GET",
          url: "/v1/together?date=2024-02-29&days=30",
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(res30.statusCode).toBe(200);

        await app.close();
      });

      it("enforces caller identity from assertion and ignores spoofed user query parameters", async () => {
        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          getTogetherDashboardData: vi.fn().mockResolvedValue({
            household: { id: "h-1", name: "House" },
            date: "2026-09-11",
            timezone: "Asia/Kuala_Lumpur",
            members: [],
          }),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);
        const res = await app.inject({
          method: "GET",
          url: "/v1/together?userId=00000000-0000-0000-0000-000000000099",
          headers: { authorization: `Bearer ${assertion}` },
        });

        expect(res.statusCode).toBe(200);
        // Repository is invoked with the verified caller's ID from assertion, never spoofed query
        expect(testRepo.getTogetherDashboardData).toHaveBeenCalledWith(
          DEFAULT_PRIMARY_USER_ID,
          expect.any(String),
          "Asia/Kuala_Lumpur",
          7,
        );

        await app.close();
      });

      it("rejects cross-user meal and workout mutations", async () => {
        const partnerMealId = "55555555-5555-4555-a555-555555555555";
        const partnerWorkoutId = "66666666-6666-4666-a666-666666666666";

        const testRepo = {
          getUser: vi.fn().mockResolvedValue({ id: DEFAULT_PRIMARY_USER_ID, active: true }),
          getSettings: vi.fn().mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" }),
          updateMeal: vi.fn().mockRejectedValue(new NotFoundError("Meal not found")),
          deleteMeal: vi.fn().mockRejectedValue(new NotFoundError("Meal not found")),
          finishWorkout: vi.fn().mockRejectedValue(new NotFoundError("Workout not found")),
        } as unknown as HealthRepository;

        const app = createApp({
          repository: testRepo,
          webToken,
          openclawToken,
          assertionSecret: appSecret,
          logger: false,
        });

        const assertion = await makeTestAssertion(DEFAULT_PRIMARY_USER_ID);

        // Caller User A attempts to update partner's meal
        const patchRes = await app.inject({
          method: "PATCH",
          url: `/v1/meals/${partnerMealId}`,
          headers: { authorization: `Bearer ${assertion}` },
          payload: { label: "Hacked meal" },
        });
        expect(patchRes.statusCode).toBe(404);
        expect(patchRes.json().error.code).toBe("NOT_FOUND");

        // Caller User A attempts to delete partner's meal
        const deleteRes = await app.inject({
          method: "DELETE",
          url: `/v1/meals/${partnerMealId}`,
          headers: { authorization: `Bearer ${assertion}` },
        });
        expect(deleteRes.statusCode).toBe(404);
        expect(deleteRes.json().error.code).toBe("NOT_FOUND");

        // Caller User A attempts to finish partner's workout
        const finishRes = await app.inject({
          method: "POST",
          url: `/v1/workouts/${partnerWorkoutId}/finish`,
          headers: { authorization: `Bearer ${assertion}` },
          payload: {},
        });
        expect(finishRes.statusCode).toBe(404);
        expect(finishRes.json().error.code).toBe("NOT_FOUND");

        await app.close();
      });
    });
  });
});



