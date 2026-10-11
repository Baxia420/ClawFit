import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nutritionCoverage, sumNutrition } from "@clawfit/health-core";
import { calendarTrend, calculateDailyProgress, calculateTrendSummary, calculateTogetherMemberProgress, recordedMetric } from "./dashboard";
import { TrendTooltip } from "../components/TrendChart";

describe("Partial nutrition and logged-day coverage", () => {
  const known = { caloriesBest: 1005, caloriesLow: 900, caloriesHigh: 1100, proteinG: 48.9, carbsG: 120, fatG: 35, fiberG: 5 };
  const allowance = { caloriesBest: 1000, caloriesLow: null, caloriesHigh: null, proteinG: null, carbsG: null, fatG: null, fiberG: null };
  const goals = { calorieTarget: 2300, proteinTargetG: 160 };
  it("retains strict unknown totals while exposing known subtotals and missing counts", () => {
    const rows = [known, allowance];
    expect(sumNutrition(rows).proteinG).toBeNull();
    expect(sumNutrition(rows).caloriesBest).toBe(2005);
    const coverage = nutritionCoverage(rows);
    expect(coverage.knownTotals.proteinG).toBe(48.9);
    expect(coverage.missingCounts.proteinG).toBe(1);
    expect(recordedMetric(null, "proteinG", "protein", coverage)).toMatchObject({ value: "48.9+", status: "partial" });
    const progress = calculateDailyProgress(sumNutrition(rows), goals, coverage);
    expect(progress.proteinPct).toBeNull();
    expect(progress.proteinHint).not.toContain("remaining");
    const shared = calculateTogetherMemberProgress(2300, 2005, 160, null, [], coverage);
    expect(shared.proteinAriaValueNow).toBeUndefined();
    expect(shared.proteinDiff).toBeNull();
  });
  it("does not present an unlogged day as zero consumption or full remaining", () => {
    const coverage = nutritionCoverage([]);
    const progress = calculateDailyProgress(sumNutrition([]), goals, coverage);
    expect(progress.caloriePct).toBeNull();
    expect(progress.calorieHint).toContain("No meals logged");
    expect(recordedMetric(0, "caloriesBest", "calories", coverage).value).toBe("—");
  });
  it("uses separate complete-day denominators, includes genuinely logged zero, and never zero-fills unknown", () => {
    const trend = [{ day: "2026-10-01", caloriesBest: 2000, proteinG: 100 }, { day: "2026-10-02", caloriesBest: 1000, proteinG: null }, { day: "2026-10-03", caloriesBest: 0, proteinG: 0 }];
    const result = calculateTrendSummary(trend, 7, goals);
    expect(result.calorieAverage).toBe(1000);
    expect(result.proteinAverage).toBe(50);
    expect(result.completeCalorieDays).toBe(3);
    expect(result.completeProteinDays).toBe(2);
    expect(result.proteinHint).toContain("2 of 3 logged days");
    expect(calculateTrendSummary([{ day: "2026-10-02", caloriesBest: null, proteinG: null }], 7, goals).proteinAverage).toBeNull();
    expect(calculateTrendSummary([], 7, goals).calorieAverage).toBeNull();
  });
  it("fills the complete calendar window without inventing zero intake", () => {
    const result = calendarTrend([{ day: "2026-10-02", proteinG: null }], "2026-10-03", 3);
    expect(result).toEqual([{ day: "2026-10-01", logged: false }, { day: "2026-10-02", proteinG: null }, { day: "2026-10-03", logged: false }]);
  });
  it("renders readable values, units, ranges and separate incomplete/unlogged tooltip states", () => {
    const complete = renderToStaticMarkup(createElement(TrendTooltip, { point: { day: "2026-10-02", caloriesBest: 2005, caloriesLow: 1900, caloriesHigh: 2200 }, mode: "calories" }));
    expect(complete).toContain("2005 kcal");
    expect(complete).toContain("1900–2200 kcal");
    const partial = renderToStaticMarkup(createElement(TrendTooltip, { point: { day: "2026-10-02", proteinG: null, knownProteinG: 48.9, missingProtein: 1 }, mode: "protein" }));
    expect(partial).toContain("48.9 g protein known subtotal");
    expect(partial).toContain("1 meal missing values");
    const unknown = renderToStaticMarkup(createElement(TrendTooltip, { point: { day: "2026-10-02", proteinG: null, knownProteinG: 0, missingProtein: 1, mealCount: 1 }, mode: "protein" }));
    expect(unknown).toContain("Total incomplete");
    expect(unknown).not.toContain("0 g protein known subtotal");
    expect(renderToStaticMarkup(createElement(TrendTooltip, { point: { day: "2026-10-03", logged: false }, mode: "protein" }))).toContain("No meals logged");
  });
});
