import { describe, expect, it } from "vitest";
import {
  applyItemPortionDelta,
  estimatedOneRepMax,
  formatAdjustedPortionDescription,
  getPreviousCalendarDate,
  getZonedCalendarDate,
  getZonedTimeString,
  hasItemNutrients,
  isValidCalendarDate,
  isValidIanaTimezone,
  recalculateMealFromItems,
  scaleNutritionItem,
  sumNutrition,
  workoutVolume,
  zonedDayRange,
  zonedTimeToUtc,
} from "./calculations.js";

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

  it("calculates zoned day ranges accurately across timezones", () => {
    const { start, end } = zonedDayRange("2026-09-08", "Asia/Kuala_Lumpur");
    // Kuala Lumpur is UTC+8, so 2026-09-08 00:00 is 2026-09-07 16:00 UTC
    expect(start.toISOString()).toBe("2026-09-07T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-08T16:00:00.000Z");
  });

  it("validates real calendar dates including month lengths and leap years", () => {
    // Impossible February dates
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate("2026-02-29")).toBe(false); // 2026 not leap year

    // Valid leap year February 29
    expect(isValidCalendarDate("2024-02-29")).toBe(true);  // 2024 is leap year
    expect(isValidCalendarDate("2000-02-29")).toBe(true);  // 2000 is leap year (divisible by 400)
    expect(isValidCalendarDate("1900-02-29")).toBe(false); // 1900 is not leap year (divisible by 100 but not 400)

    // Month length boundaries
    expect(isValidCalendarDate("2026-04-30")).toBe(true);
    expect(isValidCalendarDate("2026-04-31")).toBe(false); // April has 30 days
    expect(isValidCalendarDate("2026-09-30")).toBe(true);
    expect(isValidCalendarDate("2026-09-31")).toBe(false); // September has 30 days
    expect(isValidCalendarDate("2026-12-31")).toBe(true);

    // Malformed formats and out-of-range months/days
    expect(isValidCalendarDate("2026-00-10")).toBe(false);
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
    expect(isValidCalendarDate("2026-2-3")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });

  it("validates IANA timezones properly", () => {
    expect(isValidIanaTimezone("Asia/Kuala_Lumpur")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Europe/London")).toBe(true);

    expect(isValidIanaTimezone("Invalid/Zone")).toBe(false);
    expect(isValidIanaTimezone("Not/ATimezone")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });

  it("calculates previous calendar date across month, year, and leap year boundaries", () => {
    expect(getPreviousCalendarDate("2026-09-11")).toBe("2026-09-10");
    expect(getPreviousCalendarDate("2026-03-01")).toBe("2026-02-28"); // non-leap year
    expect(getPreviousCalendarDate("2024-03-01")).toBe("2024-02-29"); // leap year
    expect(getPreviousCalendarDate("2026-01-01")).toBe("2025-12-31"); // year boundary
  });

  it("extracts zoned calendar date string from Date object across timezones", () => {
    const d = new Date("2026-09-10T16:30:00.000Z");
    expect(getZonedCalendarDate(d, "UTC")).toBe("2026-09-10");
    expect(getZonedCalendarDate(d, "Asia/Kuala_Lumpur")).toBe("2026-09-11");
  });

  it("scales item nutrients independently with arithmetic without model inference", () => {
    const chicken = { name: "Chicken breast", portionDescription: "200g", calories: 330, proteinG: 62, carbsG: 0, fatG: 7.2, fiberG: 0 };
    const rice = { name: "White rice", portionDescription: "1 cup", calories: 205, proteinG: 4.2, carbsG: 45, fatG: 0.4, fiberG: 0.6 };

    // Halve the rice only
    const halfRice = scaleNutritionItem(rice, 0.5);
    expect(halfRice.calories).toBe(103);
    expect(halfRice.proteinG).toBe(2.1);
    expect(halfRice.carbsG).toBe(22.5);
    expect(halfRice.fatG).toBe(0.2);
    expect(halfRice.fiberG).toBe(0.3);

    // Chicken remains completely unchanged
    expect(chicken.calories).toBe(330);

    // Recalculate combined meal totals from updated items
    const meal = recalculateMealFromItems([chicken, halfRice], "high", ["portion verified"]);
    expect(meal.calories.best).toBe(433);
    expect(meal.macros.proteinG).toBe(64.1);
    expect(meal.macros.carbsG).toBe(22.5);
    expect(meal.macros.fatG).toBe(7.4);
    expect(meal.macros.fiberG).toBe(0.3);
    expect(meal.confidence).toBe("high");
  });

  it("identifies whether items contain item-level nutrients", () => {
    expect(hasItemNutrients([{ name: "Apple", portionDescription: "1 medium" }])).toBe(false);
    expect(hasItemNutrients([{ name: "Apple", portionDescription: "1 medium", calories: 95 }])).toBe(true);
    expect(hasItemNutrients([])).toBe(false);
  });

  it("applies item portion delta without wiping out unitemized calories or untouched items", () => {
    // A 700 kcal meal consisting of itemized rice (200 kcal) and unitemized/aggregate curry (500 kcal)
    const mealTotals = {
      calories: { best: 700, low: 640, high: 780 },
      macros: { proteinG: 35, carbsG: 75, fatG: 22, fiberG: 4 },
      confidence: "medium" as const,
      uncertaintyReasons: ["curry sauce density"],
    };

    const oldRice = { name: "White rice", portionDescription: "1 cup", calories: 200, proteinG: 4, carbsG: 44, fatG: 0.4, fiberG: 0.6 };
    const scaledRice = scaleNutritionItem(oldRice, 0.5); // Halved: 100 kcal, 2g P, 22g C, 0.2g F, 0.3g Fib

    const updatedTotals = applyItemPortionDelta(mealTotals, oldRice, scaledRice);

    // Delta calories = -100. Best estimate should be 600 kcal.
    expect(updatedTotals.calories.best).toBe(600);
    // Original spread was -60 and +80. The spread is strictly preserved!
    expect(updatedTotals.calories.low).toBe(540);
    expect(updatedTotals.calories.high).toBe(680);

    // Macros adjusted by exact delta
    expect(updatedTotals.macros.proteinG).toBe(33);
    expect(updatedTotals.macros.carbsG).toBe(53);
    expect(updatedTotals.macros.fatG).toBe(21.8);
    expect(updatedTotals.macros.fiberG).toBe(3.7);
    expect(updatedTotals.uncertaintyReasons).toEqual(["curry sauce density"]);
  });

  it("formats adjusted portion descriptions with cumulative scaling and without stacking redundant modifiers", () => {
    expect(formatAdjustedPortionDescription("1 cup", 0.5)).toBe("1 cup (halved)");
    expect(formatAdjustedPortionDescription("1 cup (halved)", 0.5)).toBe("1 cup (one-quarter)");
    expect(formatAdjustedPortionDescription("1 cup (one-quarter)", 4.0)).toBe("1 cup");
    expect(formatAdjustedPortionDescription("100 g", 0.5)).toBe("100 g (halved)");
    expect(formatAdjustedPortionDescription("100 g (halved)", 0.5)).toBe("100 g (one-quarter)");
    expect(formatAdjustedPortionDescription("200g", 1.5)).toBe("200g (1.5x)");
  });

  it("converts profile local date and time to accurate UTC instants across timezone offsets and midnight boundaries", () => {
    // 1. Asia/Kuala_Lumpur (UTC+8): 2026-09-12 at 23:30 is 2026-09-12 15:30:00Z
    const klLateNight = zonedTimeToUtc("2026-09-12", "23:30", "Asia/Kuala_Lumpur");
    expect(klLateNight.toISOString()).toBe("2026-09-12T15:30:00.000Z");
    expect(getZonedCalendarDate(klLateNight, "Asia/Kuala_Lumpur")).toBe("2026-09-12");
    expect(getZonedTimeString(klLateNight, "Asia/Kuala_Lumpur")).toBe("23:30");

    // 2. Asia/Kuala_Lumpur (UTC+8): 2026-09-13 at 00:15 is 2026-09-12 16:15:00Z
    const klEarlyMorning = zonedTimeToUtc("2026-09-13", "00:15", "Asia/Kuala_Lumpur");
    expect(klEarlyMorning.toISOString()).toBe("2026-09-12T16:15:00.000Z");
    expect(getZonedCalendarDate(klEarlyMorning, "Asia/Kuala_Lumpur")).toBe("2026-09-13");
    expect(getZonedTimeString(klEarlyMorning, "Asia/Kuala_Lumpur")).toBe("00:15");

    // 3. America/New_York (UTC-4 in September EDT): 2026-09-12 at 23:30 is 2026-09-13 03:30:00Z
    const nyLateNight = zonedTimeToUtc("2026-09-12", "23:30", "America/New_York");
    expect(nyLateNight.toISOString()).toBe("2026-09-13T03:30:00.000Z");
    expect(getZonedCalendarDate(nyLateNight, "America/New_York")).toBe("2026-09-12");
    expect(getZonedTimeString(nyLateNight, "America/New_York")).toBe("23:30");

    // 4. UTC: 2026-09-12 at 23:30 is 2026-09-12 23:30:00Z
    const utcDate = zonedTimeToUtc("2026-09-12", "23:30", "UTC");
    expect(utcDate.toISOString()).toBe("2026-09-12T23:30:00.000Z");
    expect(getZonedCalendarDate(utcDate, "UTC")).toBe("2026-09-12");
    expect(getZonedTimeString(utcDate, "UTC")).toBe("23:30");
  });
});

