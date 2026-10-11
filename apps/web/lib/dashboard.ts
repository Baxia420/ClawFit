import type { NutritionCoverage } from "@clawfit/health-core";

export type DailyNutritionTotals = {
  caloriesBest: number | null;
  caloriesLow: number | null;
  caloriesHigh: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

export type GoalTargets = {
  calorieTarget: number;
  proteinTargetG: number;
};

export type DailyProgress = {
  calorieHint: string;
  proteinHint: string;
  caloriePct: number | null;
  proteinPct: number | null;
  calorieBarWidth: number;
  proteinBarWidth: number;
  isOverCalorieTarget: boolean;
  isOverProteinTarget: boolean;
};

export function calculateDailyProgress(totals: DailyNutritionTotals, goals: GoalTargets, coverage?: NutritionCoverage): DailyProgress {
  const target = goals.calorieTarget;
  const proteinTarget = goals.proteinTargetG;

  const empty = coverage?.mealCount === 0;
  const calorieDiff = target - (totals.caloriesBest ?? 0);
  const proteinDiff = proteinTarget - (totals.proteinG ?? 0);

  const calorieHint = empty ? "No meals logged for this day" : totals.caloriesBest === null ? "Calories incomplete: historical intake includes unknown values" : calorieDiff >= 0
    ? `${Math.round(calorieDiff)} kcal remaining`
    : `+${Math.round(Math.abs(calorieDiff))} kcal over target`;

  const proteinHint = empty ? "No meals logged for this day" : totals.proteinG === null ? "Protein unknown for one or more meals" : proteinDiff >= 0
    ? `${Math.round(proteinDiff)} g remaining`
    : `+${Math.round(Math.abs(proteinDiff))} g over target`;

  const caloriePct = empty || totals.caloriesBest === null ? null : target > 0 ? Math.round(((totals.caloriesBest ?? 0) / target) * 100) : 0;
  const proteinPct = empty || totals.proteinG === null ? null : proteinTarget > 0 ? Math.round(((totals.proteinG ?? 0) / proteinTarget) * 100) : 0;
  const calorieBarWidth = Math.min(Math.max(caloriePct ?? 0, 0), 100);
  const proteinBarWidth = Math.min(Math.max(proteinPct ?? 0, 0), 100);

  return {
    calorieHint,
    proteinHint,
    caloriePct,
    proteinPct,
    calorieBarWidth,
    proteinBarWidth,
    isOverCalorieTarget: totals.caloriesBest !== null && calorieDiff < 0,
    isOverProteinTarget: totals.proteinG !== null && proteinDiff < 0,
  };
}

export type TrendDataPoint = {
  day: string;
  caloriesBest: number | null;
  caloriesLow?: number | null;
  caloriesHigh?: number | null;
  proteinG: number | null;
};

export type TrendSummary = {
  calorieAverage: number | null;
  proteinAverage: number | null;
  calorieHint: string;
  proteinHint: string;
  activeDays: number;
  completeCalorieDays: number;
  completeProteinDays: number;
};

export function calculateTrendSummary(
  trend: readonly TrendDataPoint[],
  days: number,
  goals: GoalTargets,
): TrendSummary {
  const count = trend.length;
  const calorieAverage = nullableAverage(trend.map(row => row.caloriesBest));
  const proteinAverage = nullableAverage(trend.map(row => row.proteinG));

  const completeCalorieDays = trend.filter(row => row.caloriesBest !== null).length;
  const completeProteinDays = trend.filter(row => row.proteinG !== null).length;
  const calorieHint = !count ? `No meals logged in this ${days}D window` : calorieAverage === null ? "Calories incomplete on one or more logged days" : count
    ? `${Math.round((calorieAverage / goals.calorieTarget) * 100)}% of target · ${count} active logged ${count === 1 ? "day" : "days"} in ${days}D window`
    : `0 active logged days in ${days}D window`;

  const proteinHint = !count ? `No meals logged in this ${days}D window` : proteinAverage === null ? "Protein incomplete on one or more logged days" : count
    ? `${Math.round((proteinAverage / goals.proteinTargetG) * 100)}% of target · ${count} active logged ${count === 1 ? "day" : "days"}`
    : "0 active logged days";

  return {
    calorieAverage,
    proteinAverage,
    calorieHint: completeCalorieDays < count ? `${completeCalorieDays} of ${count} logged days have complete calories · ${count}/${days} days logged` : calorieHint,
    proteinHint: completeProteinDays < count ? `${completeProteinDays} of ${count} logged days have complete protein · ${count}/${days} days logged` : proteinHint,
    activeDays: count, completeCalorieDays, completeProteinDays,
  };
}

export function formatLocalCalendarDate(value: string | Date, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export interface TogetherTrendSummary {
  loggedDaysCount: number;
  avgCalories: number | null;
  avgProteinG: number | null;
  completeCalorieDays: number;
  completeProteinDays: number;
}

export function calculateTogetherTrendSummary(
  trend: readonly { day: string; calories: number | null; proteinG: number | null }[] | undefined,
): TogetherTrendSummary {
  // All rows in repository trend represent days with confirmed meals, including 0-calorie days.
  const points = trend ?? [];
  const loggedDaysCount = points.length;
  if (loggedDaysCount === 0) {
    return { loggedDaysCount: 0, avgCalories: null, avgProteinG: null, completeCalorieDays: 0, completeProteinDays: 0 };
  }

  return {
    loggedDaysCount,
    completeCalorieDays: points.filter(p => p.calories !== null).length,
    completeProteinDays: points.filter(p => p.proteinG !== null).length,
    avgCalories: nullableAverage(points.map(p => p.calories)),
    avgProteinG: nullableAverage(points.map(p => p.proteinG)),
  };
}

export interface TogetherMemberProgressCalculation {
  calorieTarget: number;
  caloriesConsumed: number | null;
  calorieDiff: number | null;
  caloriePct: number | null;
  calorieBoundedBar: number;
  calorieAriaValueNow: number | undefined;
  calorieAriaValueMin: number;
  calorieAriaValueMax: number;
  calorieAccessibleText: string;
  calorieHint: string;

  proteinTarget: number;
  proteinConsumed: number | null;
  proteinDiff: number | null;
  proteinPct: number | null;
  proteinBoundedBar: number;
  proteinAriaValueNow: number | undefined;
  proteinAriaValueMin: number;
  proteinAriaValueMax: number;
  proteinAccessibleText: string;
  proteinHint: string;

  trendSummary: TogetherTrendSummary;
}

export function calculateTogetherMemberProgress(
  calorieTarget: number,
  caloriesConsumed: number | null,
  proteinTarget: number,
  proteinConsumed: number | null,
  trend?: readonly { day: string; calories: number | null; proteinG: number | null }[],
  coverage?: NutritionCoverage,
): TogetherMemberProgressCalculation {
  const empty = coverage?.mealCount === 0;
  const calorieDiff = empty || caloriesConsumed === null ? null : calorieTarget - caloriesConsumed;
  const caloriePct = empty || caloriesConsumed === null ? null : calorieTarget > 0 ? Math.round(((caloriesConsumed ?? 0) / calorieTarget) * 100) : 0;
  const calorieBoundedBar = Math.min(100, Math.max(0, caloriePct ?? 0));
  const calorieAriaValueMin = 0;
  const calorieAriaValueMax = calorieTarget > 0 ? calorieTarget : 100;
  const calorieAriaValueNow = empty || caloriesConsumed === null ? undefined : Math.min(calorieAriaValueMax, Math.max(0, caloriesConsumed ?? 0));
  const calorieHint =
    empty ? "No meals logged for this day" : calorieDiff === null ? "Calories unknown for one or more meals" : calorieDiff > 0
      ? `${calorieDiff} kcal remaining`
      : calorieDiff === 0
        ? "Target reached"
        : `${Math.abs(calorieDiff)} kcal over target`;
  const calorieAccessibleText = `${caloriesConsumed ?? "Unknown"} of ${calorieTarget} kcal (${calorieHint})`;

  const proteinDiff = empty || proteinConsumed === null ? null : proteinTarget - proteinConsumed;
  const proteinPct = empty || proteinConsumed === null ? null : proteinTarget > 0 ? Math.round(((proteinConsumed ?? 0) / proteinTarget) * 100) : 0;
  const proteinBoundedBar = Math.min(100, Math.max(0, proteinPct ?? 0));
  const proteinAriaValueMin = 0;
  const proteinAriaValueMax = proteinTarget > 0 ? proteinTarget : 100;
  const proteinAriaValueNow = empty || proteinConsumed === null ? undefined : Math.min(proteinAriaValueMax, Math.max(0, proteinConsumed ?? 0));
  const proteinHint =
    empty ? "No meals logged for this day" : proteinDiff === null ? "Protein unknown for one or more meals" : proteinDiff > 0
      ? `${proteinDiff} g remaining`
      : `Target met (${proteinConsumed} g)`;
  const proteinAccessibleText = `${proteinConsumed ?? "Unknown"} of ${proteinTarget} g (${proteinHint})`;

  return {
    calorieTarget,
    caloriesConsumed,
    calorieDiff,
    caloriePct,
    calorieBoundedBar,
    calorieAriaValueNow,
    calorieAriaValueMin,
    calorieAriaValueMax,
    calorieAccessibleText,
    calorieHint,

    proteinTarget,
    proteinConsumed,
    proteinDiff,
    proteinPct,
    proteinBoundedBar,
    proteinAriaValueNow,
    proteinAriaValueMin,
    proteinAriaValueMax,
    proteinAccessibleText,
    proteinHint,

    trendSummary: calculateTogetherTrendSummary(trend),
  };
}


function nullableAverage(values: readonly (number | null)[]): number | null {
  const complete = values.filter((value): value is number => value !== null);
  return complete.length ? Math.round(complete.reduce((sum, value) => sum + value, 0) / complete.length) : null;
}

export function recordedMetric(total: number | null, field: keyof NutritionCoverage["knownTotals"], unit: string, coverage?: NutritionCoverage) {
  if (coverage?.mealCount === 0) return { value: "—", hint: "No meals logged", status: "empty" as const };
  const missing = coverage?.missingCounts[field] ?? (total === null ? 1 : 0);
  if (missing) {
    const knownCount = coverage ? coverage.mealCount - missing : 0;
    const value = knownCount > 0 ? `${roundNutrition(coverage!.knownTotals[field])}+` : "Unknown";
    return { value, hint: `${missing} ${missing === 1 ? "meal" : "meals"} missing ${unit} · total incomplete`, status: "partial" as const };
  }
  return { value: total === null ? "Unknown" : String(roundNutrition(total)), hint: "Recorded total", status: "complete" as const };
}

export function roundNutrition(value: number): number { return Math.round(value * 10) / 10; }

export function calendarTrend<T extends { day: string }>(points: readonly T[], endDay: string, days: number): (T | { day: string; logged: false })[] {
  const byDay = new Map(points.map(point => [point.day, point]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(`${endDay}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (days - 1 - index));
    const day = date.toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, logged: false as const };
  });
}
