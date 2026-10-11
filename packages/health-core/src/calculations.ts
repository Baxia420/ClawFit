export type MacroNumbers = {
  caloriesBest: number | null;
  caloriesLow: number | null;
  caloriesHigh: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
};

export type NutritionTotals = MacroNumbers;

export type NutritionCoverage = {
  mealCount: number;
  knownTotals: Record<keyof MacroNumbers, number>;
  missingCounts: Record<keyof MacroNumbers, number>;
};

/** Partial subtotals accompany strict totals; unknown values never become complete totals. */
export function nutritionCoverage(rows: readonly MacroNumbers[]): NutritionCoverage {
  const knownTotals = { caloriesBest: 0, caloriesLow: 0, caloriesHigh: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 };
  const missingCounts = { ...knownTotals };
  for (const row of rows) {
    for (const key of Object.keys(knownTotals) as (keyof MacroNumbers)[]) {
      const value = row[key];
      if (value === null) missingCounts[key] += 1;
      else knownTotals[key] += value;
    }
  }
  return { mealCount: rows.length, knownTotals, missingCounts };
}

export function sumNutrition(rows: readonly MacroNumbers[]): NutritionTotals {
  return rows.reduce<NutritionTotals>(
    (total, row) => ({
      caloriesBest: addKnown(total.caloriesBest, row.caloriesBest),
      caloriesLow: addKnown(total.caloriesLow, row.caloriesLow),
      caloriesHigh: addKnown(total.caloriesHigh, row.caloriesHigh),
      proteinG: addKnown(total.proteinG, row.proteinG),
      carbsG: addKnown(total.carbsG, row.carbsG),
      fatG: addKnown(total.fatG, row.fatG),
      fiberG: addKnown(total.fiberG, row.fiberG),
    }),
    { caloriesBest: 0, caloriesLow: 0, caloriesHigh: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
  );
}

function addKnown(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function workoutSetVolume(weightKg: number | null, reps: number): number {
  return weightKg === null ? 0 : weightKg * reps;
}

export function workoutVolume(sets: readonly { weightKg: number | null; reps: number }[]): number {
  return sets.reduce((total, set) => total + workoutSetVolume(set.weightKg, set.reps), 0);
}

export function estimatedOneRepMax(weightKg: number | null, reps: number): number | null {
  if (weightKg === null || weightKg <= 0 || reps <= 0) return null;
  if (reps === 1) return weightKg;
  return Math.round(weightKg * (1 + reps / 30) * 10) / 10;
}

export function zonedDateToUtc(date: string, timezone: string): Date {
  const target = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return new Date(target.getTime() - (represented - target.getTime()));
}

export function zonedDayRange(date: string, timezone: string): { start: Date; end: Date } {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  return { start: zonedDateToUtc(date, timezone), end: zonedDateToUtc(nextDate, timezone) };
}

export function isValidCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (daysInMonth[m - 1] ?? 0);
}

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getZonedCalendarDate(date: Date = new Date(), timeZone: string = "Asia/Kuala_Lumpur"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getPreviousCalendarDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y!, m! - 1, d!));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  const prevY = utcDate.getUTCFullYear();
  const prevM = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const prevD = String(utcDate.getUTCDate()).padStart(2, "0");
  return `${prevY}-${prevM}-${prevD}`;
}

