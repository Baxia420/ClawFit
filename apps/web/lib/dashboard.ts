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
  caloriePct: number;
  proteinPct: number;
  calorieBarWidth: number;
  proteinBarWidth: number;
  isOverCalorieTarget: boolean;
  isOverProteinTarget: boolean;
};

export function calculateDailyProgress(totals: DailyNutritionTotals, goals: GoalTargets): DailyProgress {
  const target = goals.calorieTarget;
  const proteinTarget = goals.proteinTargetG;

  const calorieDiff = target - (totals.caloriesBest ?? 0);
  const proteinDiff = proteinTarget - (totals.proteinG ?? 0);

  const calorieHint = totals.caloriesBest === null ? "Calories incomplete: historical intake includes unknown values" : calorieDiff >= 0
    ? `${Math.round(calorieDiff)} kcal remaining`
    : `+${Math.round(Math.abs(calorieDiff))} kcal over target`;

  const proteinHint = totals.proteinG === null ? "Protein unknown for one or more meals" : proteinDiff >= 0
    ? `${Math.round(proteinDiff)} g remaining`
    : `+${Math.round(Math.abs(proteinDiff))} g over target`;

  const caloriePct = target > 0 ? Math.round(((totals.caloriesBest ?? 0) / target) * 100) : 0;
  const proteinPct = proteinTarget > 0 ? Math.round(((totals.proteinG ?? 0) / proteinTarget) * 100) : 0;
  const calorieBarWidth = Math.min(Math.max(caloriePct, 0), 100);
  const proteinBarWidth = Math.min(Math.max(proteinPct, 0), 100);

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
};

export function calculateTrendSummary(
  trend: readonly TrendDataPoint[],
  days: number,
  goals: GoalTargets,
): TrendSummary {
  const count = trend.length;
  const calorieAverage = nullableAverage(trend.map(row => row.caloriesBest));
  const proteinAverage = nullableAverage(trend.map(row => row.proteinG));

  const calorieHint = calorieAverage === null ? "Calories incomplete on one or more logged days" : count
    ? `${Math.round((calorieAverage / goals.calorieTarget) * 100)}% of target · ${count} active logged ${count === 1 ? "day" : "days"} in ${days}D window`
    : `0 active logged days in ${days}D window`;

  const proteinHint = proteinAverage === null ? "Protein incomplete on one or more logged days" : count
    ? `${Math.round((proteinAverage / goals.proteinTargetG) * 100)}% of target · ${count} active logged ${count === 1 ? "day" : "days"}`
    : "0 active logged days";

  return {
    calorieAverage,
    proteinAverage,
    calorieHint,
    proteinHint,
    activeDays: count,
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
}

export function calculateTogetherTrendSummary(
  trend: readonly { day: string; calories: number | null; proteinG: number | null }[] | undefined,
): TogetherTrendSummary {
  // All rows in repository trend represent days with confirmed meals, including 0-calorie days.
  const points = trend ?? [];
  const loggedDaysCount = points.length;
  if (loggedDaysCount === 0) {
    return { loggedDaysCount: 0, avgCalories: 0, avgProteinG: 0 };
  }

  return {
    loggedDaysCount,
    avgCalories: nullableAverage(points.map(p => p.calories)),
    avgProteinG: nullableAverage(points.map(p => p.proteinG)),
  };
}

export interface TogetherMemberProgressCalculation {
  calorieTarget: number;
  caloriesConsumed: number | null;
  calorieDiff: number | null;
  caloriePct: number;
  calorieBoundedBar: number;
  calorieAriaValueNow: number;
  calorieAriaValueMin: number;
  calorieAriaValueMax: number;
  calorieAccessibleText: string;
  calorieHint: string;

  proteinTarget: number;
  proteinConsumed: number | null;
  proteinDiff: number | null;
  proteinPct: number;
  proteinBoundedBar: number;
  proteinAriaValueNow: number;
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
): TogetherMemberProgressCalculation {
  const calorieDiff = caloriesConsumed === null ? null : calorieTarget - caloriesConsumed;
  const caloriePct = calorieTarget > 0 ? Math.round(((caloriesConsumed ?? 0) / calorieTarget) * 100) : 0;
  const calorieBoundedBar = Math.min(100, Math.max(0, caloriePct));
  const calorieAriaValueMin = 0;
  const calorieAriaValueMax = calorieTarget > 0 ? calorieTarget : 100;
  const calorieAriaValueNow = Math.min(calorieAriaValueMax, Math.max(0, caloriesConsumed ?? 0));
  const calorieHint =
    calorieDiff === null ? "Calories unknown for one or more meals" : calorieDiff > 0
      ? `${calorieDiff} kcal remaining`
      : calorieDiff === 0
        ? "Target reached"
        : `${Math.abs(calorieDiff)} kcal over target`;
  const calorieAccessibleText = `${caloriesConsumed ?? "Unknown"} of ${calorieTarget} kcal (${calorieHint})`;

  const proteinDiff = proteinConsumed === null ? null : proteinTarget - proteinConsumed;
  const proteinPct = proteinTarget > 0 ? Math.round(((proteinConsumed ?? 0) / proteinTarget) * 100) : 0;
  const proteinBoundedBar = Math.min(100, Math.max(0, proteinPct));
  const proteinAriaValueMin = 0;
  const proteinAriaValueMax = proteinTarget > 0 ? proteinTarget : 100;
  const proteinAriaValueNow = Math.min(proteinAriaValueMax, Math.max(0, proteinConsumed ?? 0));
  const proteinHint =
    proteinDiff === null ? "Protein unknown for one or more meals" : proteinDiff > 0
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
  if (values.some(value => value === null)) return null;
  return values.length ? Math.round(values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / values.length) : 0;
}
