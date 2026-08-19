import { describe, expect, it, vi } from "vitest";
import { handleAssistantCommand, type AssistantHealthClient } from "./assistant";

describe("web assistant command adapter", () => {
  it("turns a meal estimate into a database-backed draft", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/v1/nutrition/estimate") return { estimate: estimate() };
      if (path === "/v1/meals/pending") return pendingMeal();
      throw new Error(`Unexpected ${path}`);
    });
    const result = await handleAssistantCommand({ message: "I ate 2 eggs and toast", requestId: "11111111-1111-4111-a111-111111111111" }, { request } as unknown as AssistantHealthClient);
    expect(result.kind).toBe("meal_draft");
    expect(result.meal?.caloriesBest).toBe(330);
    expect(request).toHaveBeenCalledWith("/v1/meals/pending", expect.objectContaining({ method: "POST" }));
    expect(request).toHaveBeenCalledWith("/v1/meals/pending", expect.objectContaining({ body: expect.stringContaining('"scopeKey":"web:primary"') }));
  });

  it("confirms the latest pending meal using the idempotent backend route", async () => {
    const request = vi.fn(async (path: string) => path.endsWith("/confirm") ? { ...pendingMeal(), confirmed: true } : { pending: pendingMeal() });
    const result = await handleAssistantCommand({ message: "log it", requestId: "22222222-2222-4222-a222-222222222222" }, { request } as unknown as AssistantHealthClient);
    expect(result.kind).toBe("meal_logged");
    expect(request).toHaveBeenCalledWith("/v1/meals/pending/latest?scopeKey=web%3Aprimary");
    expect(request).toHaveBeenLastCalledWith(`/v1/meals/pending/${pendingMeal().id}/confirm`, { method: "POST", body: '{"scopeKey":"web:primary"}' });
  });

  it("resolves repeated-set shorthand from the authoritative active workout", async () => {
    const workout = { workout: { id: "workout-1", name: "Push", status: "active", startedAt: "2026-08-19T10:00:00Z" }, exercises: [{ id: "exercise-1", name: "Bench", sets: [{ id: "set-1", setNumber: 1, weightKg: 80, reps: 8, occurredAt: "2026-08-19T10:05:00Z" }] }], volumeKg: 640, setCount: 1 };
    const request = vi.fn(async (path: string) => path === "/v1/workouts/active" ? workout : { id: "set-2" });
    const result = await handleAssistantCommand({ message: "8 again", requestId: "33333333-3333-4333-a333-333333333333" }, { request } as unknown as AssistantHealthClient);
    expect(result.kind).toBe("set_logged");
    expect(request).toHaveBeenCalledWith("/v1/workouts/workout-1/sets", expect.objectContaining({ body: expect.stringContaining('"weightKg":80') }));
  });

  it("reads daily nutrition without relying on conversation memory", async () => {
    const request = vi.fn(async (path: string) => path === "/v1/settings" ? { timezone: "Asia/Kuala_Lumpur" } : { totals: { caloriesBest: 900, proteinG: 70, carbsG: 80, fatG: 30 }, meals: [{ label: "Eggs" }] });
    const result = await handleAssistantCommand({ message: "What did I eat today?", requestId: "44444444-4444-4444-a444-444444444444" }, { request } as unknown as AssistantHealthClient, new Date("2026-08-19T04:00:00Z"));
    expect(result.kind).toBe("nutrition");
    expect(result.nutrition?.calories).toBe(900);
    expect(request).toHaveBeenLastCalledWith("/v1/nutrition/daily?date=2026-08-19&timezone=Asia%2FKuala_Lumpur");
  });
});

function estimate() {
  return { label: "Eggs and toast", items: [{ name: "Eggs", portionDescription: "2 large" }], calories: { best: 330, low: 290, high: 390 }, macros: { proteinG: 19, carbsG: 31, fatG: 15, fiberG: 3 }, confidence: "medium" as const, uncertaintyReasons: ["Bread size"] };
}

function pendingMeal() {
  return { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "Eggs and toast", caloriesBest: 330, caloriesLow: 290, caloriesHigh: 390, proteinG: 19, carbsG: 31, fatG: 15, fiberG: 3, confidence: "medium" as const, uncertaintyReasons: ["Bread size"], confirmed: false };
}
