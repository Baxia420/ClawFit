export type DailyNutritionTotals = {
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
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

  const calorieDiff = target - totals.caloriesBest;
  const proteinDiff = proteinTarget - totals.proteinG;

  const calorieHint = calorieDiff >= 0
    ? `${Math.round(calorieDiff)} kcal remaining`
    : `+${Math.round(Math.abs(calorieDiff))} kcal over target`;

  const proteinHint = proteinDiff >= 0
    ? `${Math.round(proteinDiff)} g remaining`
    : `+${Math.round(Math.abs(proteinDiff))} g over target`;

  const caloriePct = target > 0 ? Math.round((totals.caloriesBest / target) * 100) : 0;
  const proteinPct = proteinTarget > 0 ? Math.round((totals.proteinG / proteinTarget) * 100) : 0;
  const calorieBarWidth = Math.min(Math.max(caloriePct, 0), 100);
  const proteinBarWidth = Math.min(Math.max(proteinPct, 0), 100);

  return {
    calorieHint,
    proteinHint,
    caloriePct,
    proteinPct,
    calorieBarWidth,
    proteinBarWidth,
    isOverCalorieTarget: calorieDiff < 0,
    isOverProteinTarget: proteinDiff < 0,
  };
}

export type TrendDataPoint = {
  day: string;
  caloriesBest: number;
  caloriesLow?: number;
  caloriesHigh?: number;
  proteinG: number;
};

export type TrendSummary = {
  calorieAverage: number;
  proteinAverage: number;
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
  const calorieAverage = count ? Math.round(trend.reduce((sum, row) => sum + row.caloriesBest, 0) / count) : 0;
  const proteinAverage = count ? Math.round(trend.reduce((sum, row) => sum + row.proteinG, 0) / count) : 0;

  const calorieHint = count
    ? `${Math.round((calorieAverage / goals.calorieTarget) * 100)}% of target · ${count} active logged ${count === 1 ? "day" : "days"} in ${days}D window`
    : `0 active logged days in ${days}D window`;

  const proteinHint = count
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
  avgCalories: number;
  avgProteinG: number;
}

export function calculateTogetherTrendSummary(
  trend: readonly { day: string; calories: number; proteinG: number }[] | undefined,
): TogetherTrendSummary {
  // All rows in repository trend represent days with confirmed meals, including 0-calorie days.
  const points = trend ?? [];
  const loggedDaysCount = points.length;
  if (loggedDaysCount === 0) {
    return { loggedDaysCount: 0, avgCalories: 0, avgProteinG: 0 };
  }
  const totalCalories = points.reduce((acc, p) => acc + p.calories, 0);
  const totalProtein = points.reduce((acc, p) => acc + p.proteinG, 0);
  return {
    loggedDaysCount,
    avgCalories: Math.round(totalCalories / loggedDaysCount),
    avgProteinG: Math.round(totalProtein / loggedDaysCount),
  };
}

export interface TogetherMemberProgressCalculation {
  calorieTarget: number;
  caloriesConsumed: number;
  calorieDiff: number;
  caloriePct: number;
  calorieBoundedBar: number;
  calorieAriaValueNow: number;
  calorieAriaValueMin: number;
  calorieAriaValueMax: number;
  calorieAccessibleText: string;
  calorieHint: string;

  proteinTarget: number;
  proteinConsumed: number;
  proteinDiff: number;
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
  caloriesConsumed: number,
  proteinTarget: number,
  proteinConsumed: number,
  trend?: readonly { day: string; calories: number; proteinG: number }[],
): TogetherMemberProgressCalculation {
  const calorieDiff = calorieTarget - caloriesConsumed;
  const caloriePct = calorieTarget > 0 ? Math.round((caloriesConsumed / calorieTarget) * 100) : 0;
  const calorieBoundedBar = Math.min(100, Math.max(0, caloriePct));
  const calorieAriaValueMin = 0;
  const calorieAriaValueMax = calorieTarget > 0 ? calorieTarget : 100;
  const calorieAriaValueNow = Math.min(calorieAriaValueMax, Math.max(0, caloriesConsumed));
  const calorieHint =
    calorieDiff > 0
      ? `${calorieDiff} kcal remaining`
      : calorieDiff === 0
        ? "Target reached"
        : `${Math.abs(calorieDiff)} kcal over target`;
  const calorieAccessibleText = `${caloriesConsumed} of ${calorieTarget} kcal (${calorieHint})`;

  const proteinDiff = proteinTarget - proteinConsumed;
  const proteinPct = proteinTarget > 0 ? Math.round((proteinConsumed / proteinTarget) * 100) : 0;
  const proteinBoundedBar = Math.min(100, Math.max(0, proteinPct));
  const proteinAriaValueMin = 0;
  const proteinAriaValueMax = proteinTarget > 0 ? proteinTarget : 100;
  const proteinAriaValueNow = Math.min(proteinAriaValueMax, Math.max(0, proteinConsumed));
  const proteinHint =
    proteinDiff > 0
      ? `${proteinDiff} g remaining`
      : `Target met (${proteinConsumed} g)`;
  const proteinAccessibleText = `${proteinConsumed} of ${proteinTarget} g (${proteinHint})`;

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

