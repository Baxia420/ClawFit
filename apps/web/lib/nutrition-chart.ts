export type ChartPoint = {
  day: string;
  logged?: boolean;
  mealCount?: number | undefined;
  caloriesBest?: number | null;
  caloriesLow?: number | null;
  caloriesHigh?: number | null;
  proteinG?: number | null;
  estimatedOneRepMax?: number;
  knownCalories?: number | undefined;
  knownProteinG?: number | undefined;
  missingCalories?: number | undefined;
  missingProtein?: number | undefined;
};

export function nutritionChartGaps(points: readonly ChartPoint[]) {
  return points.flatMap(point => {
    const issues = point.logged === false ? ["No meals logged"] : [
      ...(point.caloriesBest == null ? ["Calories incomplete"] : []),
      ...(point.proteinG == null ? ["Protein incomplete"] : []),
      ...(point.caloriesLow == null || point.caloriesHigh == null ? ["Calorie range unavailable"] : []),
    ];
    return issues.length ? [{ point, issues }] : [];
  });
}

export function trendChartPoints(points: readonly ChartPoint[]) {
  return points.map(point => {
    const low = point.caloriesLow, high = point.caloriesHigh;
    const hasRange = point.logged !== false && low != null && high != null;
    return {
      ...point,
      calorieRange: hasRange ? [low, high] : null,
      calorieRangeMidpoint: hasRange ? (low + high) / 2 : null,
      calorieRangeError: hasRange ? (high - low) / 2 : null,
    };
  });
}
