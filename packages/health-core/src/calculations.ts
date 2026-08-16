export type MacroNumbers = {
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
};

export type NutritionTotals = Omit<MacroNumbers, "fiberG"> & { fiberG: number };

export function sumNutrition(rows: readonly MacroNumbers[]): NutritionTotals {
  return rows.reduce<NutritionTotals>(
    (total, row) => ({
      caloriesBest: total.caloriesBest + row.caloriesBest,
      caloriesLow: total.caloriesLow + row.caloriesLow,
      caloriesHigh: total.caloriesHigh + row.caloriesHigh,
      proteinG: total.proteinG + row.proteinG,
      carbsG: total.carbsG + row.carbsG,
      fatG: total.fatG + row.fatG,
      fiberG: total.fiberG + (row.fiberG ?? 0),
    }),
    { caloriesBest: 0, caloriesLow: 0, caloriesHigh: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
  );
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
