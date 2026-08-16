import { describe, expect, it, vi } from "vitest";
import { NutritionEstimator, nutritionEstimateSchema, type NutritionModelClient } from "./index.js";

const valid = {
  label: "Eggs on toast",
  items: [{ name: "eggs", portion_description: "3 large eggs" }],
  calories: { best: 480, low: 430, high: 550 },
  macros: { protein_g: 30, carbs_g: 32, fat_g: 25, fiber_g: 4 },
  confidence: "medium",
  uncertainty_reasons: ["unknown cooking fat"],
};

describe("nutrition model boundary", () => {
  it("validates and normalizes structured model output", async () => {
    const client: NutritionModelClient = { generate: vi.fn().mockResolvedValue(valid) };
    const result = await new NutritionEstimator(client, ["primary"]).estimate({ text: "3 eggs and toast" });
    expect(result.estimate.macros.proteinG).toBe(30);
    expect(nutritionEstimateSchema.safeParse(result.estimate).success).toBe(true);
  });

  it("falls back once when the primary fails", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(valid);
    const result = await new NutritionEstimator({ generate }, ["primary", "fallback"]).estimate({ text: "meal" });
    expect(result.model).toBe("fallback");
    expect(result.fallbackUsed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid low-confidence false precision", () => {
    expect(
      nutritionEstimateSchema.safeParse({ ...valid, confidence: "low", calories: { best: 500, low: 500, high: 500 } }).success,
    ).toBe(false);
  });
});
