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

  it("falls back once when the primary fails with a transient error (e.g. 429 quota or 503 unavailable)", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("Google Generative AI error (429): RESOURCE_EXHAUSTED")).mockResolvedValueOnce(valid);
    const result = await new NutritionEstimator({ generate }, ["gemini-3.8-flash", "gemini-3.7-flash"]).estimate({ text: "meal" });
    expect(result.model).toBe("gemini-3.7-flash");
    expect(result.fallbackUsed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately without retrying fallback on non-retryable credential or client errors (e.g. 401 API_KEY_INVALID)", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("API_KEY_INVALID: 401 Unauthorized"));
    const estimator = new NutritionEstimator({ generate }, ["gemini-3.8-flash", "gemini-3.7-flash"]);

    await expect(estimator.estimate({ text: "meal" })).rejects.toThrow("Non-retryable model failure");
    // Strictly called only once — does not blindly repeat with the same invalid key
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately without retrying fallback on invalid argument errors (e.g. 400 INVALID_ARGUMENT)", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("INVALID_ARGUMENT: 400 Bad Request"));
    const estimator = new NutritionEstimator({ generate }, ["gemini-3.8-flash", "gemini-3.7-flash"]);

    await expect(estimator.estimate({ text: "meal" })).rejects.toThrow("Non-retryable model failure");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("preserves attempts list and throws NutritionEstimationError when all configured models fail", async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"))
      .mockRejectedValueOnce(new Error("503 UNAVAILABLE"));
    const estimator = new NutritionEstimator({ generate }, ["gemini-3.8-flash", "gemini-3.7-flash"]);

    const error = await estimator.estimate({ text: "meal" }).catch((e) => e);
    expect(error.name).toBe("NutritionEstimationError");
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts[0].model).toBe("gemini-3.8-flash");
    expect(error.attempts[1].model).toBe("gemini-3.7-flash");
  });

  it("rejects invalid low-confidence false precision", () => {
    expect(
      nutritionEstimateSchema.safeParse({ ...valid, confidence: "low", calories: { best: 500, low: 500, high: 500 } }).success,
    ).toBe(false);
  });
});

