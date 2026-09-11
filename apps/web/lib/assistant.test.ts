import { describe, expect, it, vi } from "vitest";
import { handleAssistantCommand, type AssistantHealthClient } from "./assistant";

describe("web assistant command adapter", () => {
  it("turns a meal estimate into a database-backed draft", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/v1/nutrition/estimate") return { estimate: estimate() };
      if (path === "/v1/meals/pending") return pendingMeal();
      throw new Error(`Unexpected ${path}`);
    });
    const result = await handleAssistantCommand(
      { message: "I ate 2 eggs and toast", requestId: "11111111-1111-4111-a111-111111111111" },
      { request } as unknown as AssistantHealthClient,
      undefined,
      "web:11111111-1111-4111-a111-111111111111",
    );
    expect(result.kind).toBe("meal_draft");
    expect(result.meal?.caloriesBest).toBe(330);
    expect(request).toHaveBeenCalledWith("/v1/meals/pending", expect.objectContaining({ method: "POST" }));
    expect(request).toHaveBeenCalledWith("/v1/meals/pending", expect.objectContaining({ body: expect.stringContaining('"scopeKey":"web:11111111-1111-4111-a111-111111111111"') }));
  });

  it("confirms the latest pending meal using the idempotent backend route", async () => {
    const request = vi.fn(async (path: string) => path.endsWith("/confirm") ? { ...pendingMeal(), confirmed: true } : { pending: pendingMeal() });
    const result = await handleAssistantCommand(
      { message: "log it", requestId: "22222222-2222-4222-a222-222222222222" },
      { request } as unknown as AssistantHealthClient,
      undefined,
      "web:22222222-2222-4222-a222-222222222222",
    );
    expect(result.kind).toBe("meal_logged");
    expect(request).toHaveBeenCalledWith("/v1/meals/pending/latest?scopeKey=web%3A22222222-2222-4222-a222-222222222222");
    expect(request).toHaveBeenLastCalledWith(`/v1/meals/pending/${pendingMeal().id}/confirm`, { method: "POST", body: '{"scopeKey":"web:22222222-2222-4222-a222-222222222222"}' });
  });

  it("resolves repeated-set shorthand from the authoritative active workout", async () => {
    const workout = { workout: { id: "workout-1", name: "Push", status: "active", startedAt: "2026-08-19T10:00:00Z" }, exercises: [{ id: "exercise-1", name: "Bench", sets: [{ id: "set-1", setNumber: 1, weightKg: 80, reps: 8, occurredAt: "2026-08-19T10:05:00Z" }] }], volumeKg: 640, setCount: 1 };
    const request = vi.fn(async (path: string) => path === "/v1/workouts/active" ? workout : { id: "set-2" });
    const result = await handleAssistantCommand(
      { message: "8 again", requestId: "33333333-3333-4333-a333-333333333333" },
      { request } as unknown as AssistantHealthClient,
      undefined,
      "web:33333333-3333-4333-a333-333333333333",
    );
    expect(result.kind).toBe("set_logged");
    expect(request).toHaveBeenCalledWith("/v1/workouts/workout-1/sets", expect.objectContaining({ body: expect.stringContaining('"weightKg":80') }));
  });

  it("reads daily nutrition without relying on conversation memory", async () => {
    const request = vi.fn(async (path: string) => path === "/v1/settings" ? { timezone: "Asia/Kuala_Lumpur" } : { totals: { caloriesBest: 900, proteinG: 70, carbsG: 80, fatG: 30 }, meals: [{ label: "Eggs" }] });
    const result = await handleAssistantCommand(
      { message: "What did I eat today?", requestId: "44444444-4444-4444-a444-444444444444" },
      { request } as unknown as AssistantHealthClient,
      new Date("2026-08-19T04:00:00Z"),
      "web:44444444-4444-4444-a444-444444444444",
    );
    expect(result.kind).toBe("nutrition");
    expect(result.nutrition?.calories).toBe(900);
    expect(request).toHaveBeenLastCalledWith("/v1/nutrition/daily?date=2026-08-19&timezone=Asia%2FKuala_Lumpur");
  });

  it("connects the nutrition API response envelope with estimate to handleAssistantCommand and validates pending draft fields", async () => {
    const apiEstimateResponse = {
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
      label: "Two poached eggs on sourdough toast",
      calories: { best: 350, low: 320, high: 380 },
      macros: { proteinG: 20, carbsG: 34, fatG: 14, fiberG: 3 },
      confidence: "high" as const,
      model: "gemini-3.8-flash",
      estimatorModelId: "gemini-3.8-flash",
      fallbackUsed: false,
    };

    let capturedPendingBody: any = null;
    const request = vi.fn(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === "/v1/nutrition/estimate") {
        return apiEstimateResponse;
      }
      if (path === "/v1/meals/pending") {
        capturedPendingBody = JSON.parse(options?.body ?? "{}");
        return {
          id: "draft-int-12345",
          label: capturedPendingBody.label,
          caloriesBest: capturedPendingBody.calories.best,
          caloriesLow: capturedPendingBody.calories.low,
          caloriesHigh: capturedPendingBody.calories.high,
          proteinG: capturedPendingBody.macros.proteinG,
          carbsG: capturedPendingBody.macros.carbsG,
          fatG: capturedPendingBody.macros.fatG,
          fiberG: capturedPendingBody.macros.fiberG,
          confidence: capturedPendingBody.confidence,
          confirmed: false,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const testScopeKey = "web:55555555-5555-4555-a555-555555555555";
    const result = await handleAssistantCommand(
      { message: "I ate two poached eggs on sourdough toast", requestId: "req-int-1" },
      { request } as unknown as AssistantHealthClient,
      undefined,
      testScopeKey,
    );

    expect(result.kind).toBe("meal_draft");
    expect(result.meal?.caloriesBest).toBe(350);
    expect(capturedPendingBody).toBeDefined();
    expect(capturedPendingBody.label).toBe("Two poached eggs on sourdough toast");
    expect(capturedPendingBody.calories.best).toBe(350);
    expect(capturedPendingBody.macros.proteinG).toBe(20);
    expect(capturedPendingBody.macros.carbsG).toBe(34);
    expect(capturedPendingBody.macros.fatG).toBe(14);
    expect(capturedPendingBody.macros.fiberG).toBe(3);
    expect(capturedPendingBody.confidence).toBe("high");
    expect(capturedPendingBody.scopeKey).toBe(testScopeKey);
    expect(capturedPendingBody.source).toBe("text");
  });

  it("rejects commands when scopeKey is missing or blank", async () => {
    const request = vi.fn();
    await expect(
      handleAssistantCommand(
        { message: "I ate an apple", requestId: "req-missing-scope" },
        { request } as unknown as AssistantHealthClient,
      ),
    ).rejects.toThrow("scopeKey is required for web assistant operations");

    await expect(
      handleAssistantCommand(
        { message: "I ate an apple", requestId: "req-blank-scope" },
        { request } as unknown as AssistantHealthClient,
        undefined,
        "   ",
      ),
    ).rejects.toThrow("scopeKey is required for web assistant operations");
  });

  it("isolates pending meal scope per user when a specific user scope is passed", async () => {
    let capturedScope: string | undefined;
    const request = vi.fn(async (path: string, init?: { body?: string }) => {
      if (path === "/v1/nutrition/estimate") return { estimate: estimate() };
      if (path === "/v1/meals/pending") {
        const body = JSON.parse(init?.body ?? "{}");
        capturedScope = body.scopeKey;
        return pendingMeal();
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const partnerUserId = "00000000-0000-0000-0000-000000000003";
    const userScope = `web:${partnerUserId}`;
    await handleAssistantCommand(
      { message: "I ate eggs and toast", requestId: "req-user-scope" },
      { request } as unknown as AssistantHealthClient,
      new Date(),
      userScope,
    );

    expect(capturedScope).toBe(userScope);
  });
});

function estimate() {
  return { label: "Eggs and toast", items: [{ name: "Eggs", portionDescription: "2 large" }], calories: { best: 330, low: 290, high: 390 }, macros: { proteinG: 19, carbsG: 31, fatG: 15, fiberG: 3 }, confidence: "medium" as const, uncertaintyReasons: ["Bread size"] };
}

function pendingMeal() {
  return { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "Eggs and toast", caloriesBest: 330, caloriesLow: 290, caloriesHigh: 390, proteinG: 19, carbsG: 31, fatG: 15, fiberG: 3, confidence: "medium" as const, uncertaintyReasons: ["Bread size"], confirmed: false };
}
