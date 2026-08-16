import { describe, expect, it } from "vitest";
import { estimatedOneRepMax, sumNutrition, workoutVolume } from "./calculations.js";

describe("deterministic calculations", () => {
  it("sums calories and macros including uncertainty bounds", () => {
    expect(
      sumNutrition([
        { caloriesBest: 500, caloriesLow: 450, caloriesHigh: 600, proteinG: 30, carbsG: 50, fatG: 20, fiberG: 5 },
        { caloriesBest: 300, caloriesLow: 250, caloriesHigh: 350, proteinG: 20, carbsG: 25, fatG: 10, fiberG: null },
      ]),
    ).toEqual({ caloriesBest: 800, caloriesLow: 700, caloriesHigh: 950, proteinG: 50, carbsG: 75, fatG: 30, fiberG: 5 });
  });

  it("calculates workout volume", () => {
    expect(workoutVolume([{ weightKg: 80, reps: 8 }, { weightKg: 80, reps: 7 }, { weightKg: null, reps: 10 }])).toBe(1_200);
  });

  it("calculates Epley estimated 1RM", () => {
    expect(estimatedOneRepMax(80, 8)).toBe(101.3);
    expect(estimatedOneRepMax(null, 8)).toBeNull();
  });
});

