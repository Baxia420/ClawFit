import { describe, expect, it } from "vitest";
import {
  estimatedOneRepMax,
  getPreviousCalendarDate,
  getZonedCalendarDate,
  isValidCalendarDate,
  isValidIanaTimezone,
  sumNutrition,
  workoutVolume,
  zonedDayRange,
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
});

