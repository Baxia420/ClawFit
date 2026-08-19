import { describe, expect, it, vi } from "vitest";
import { createApp } from "./create-app.js";
import type { HealthRepository } from "@clawfit/db";

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
    expect(pendingRepo.updatePendingMeal).toHaveBeenCalledWith(validUuid, "web:primary", { label: "Two eggs" });

    const cancelRes = await app.inject({ method: "DELETE", url: `/v1/meals/pending/${validUuid}?scopeKey=web%3Aprimary`, headers: { authorization: `Bearer ${token}` } });
    expect(cancelRes.statusCode).toBe(200);
    expect(pendingRepo.cancelPendingMeal).toHaveBeenCalledWith(validUuid, "web:primary");

    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/meals/pending/${validUuid}/confirm`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scopeKey: "web:primary" },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().id).toBe(mealUuid);
    expect(pendingRepo.confirmPendingMeal).toHaveBeenCalledWith(validUuid, { scopeKey: "web:primary" });

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
    expect(settingsRepo.updateSettings).toHaveBeenCalledWith({ calorieTarget: 2400, timezone: "Asia/Kuala_Lumpur" });

    const notificationResponse = await app.inject({
      method: "PUT",
      url: "/v1/notification-preferences/daily_summary",
      headers,
      payload: { enabled: true, timeLocal: "21:30", timezone: "Asia/Kuala_Lumpur", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], deliveryChannel: "web_push", configuration: {} },
    });
    expect(notificationResponse.statusCode).toBe(200);
    expect(settingsRepo.upsertNotificationPreference).toHaveBeenCalledWith(expect.objectContaining({ type: "daily_summary", enabled: true }));
    await app.close();
  });

});
