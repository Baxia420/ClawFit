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

export function zonedTimeToUtc(date: string, time: string, timezone: string): Date {
  const [hourStr = "0", minuteStr = "0", secondStr = "0"] = time.split(":");
  const h = Number(hourStr);
  const m = Number(minuteStr);
  const s = Number(secondStr);

  const targetGuess = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(targetGuess);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  const offsetMs = represented - targetGuess.getTime();
  const utcDate = new Date(targetGuess.getTime() - offsetMs);

  const verifyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcDate);
  const vValues = Object.fromEntries(verifyParts.map((part) => [part.type, part.value]));
  const vRepresented = Date.UTC(
    Number(vValues.year),
    Number(vValues.month) - 1,
    Number(vValues.day),
    Number(vValues.hour),
    Number(vValues.minute),
    Number(vValues.second),
  );
  const desiredWallClock = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    h,
    m,
    s,
  );
  const diff = desiredWallClock - vRepresented;
  return new Date(utcDate.getTime() + diff);
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

export function getZonedTimeString(date: Date = new Date(), timeZone: string = "Asia/Kuala_Lumpur"): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${values.hour}:${values.minute}`;
  } catch {
    return "12:00";
  }
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

export type ItemNutrientInput = {
  name: string;
  portionDescription: string;
  calories?: number | null | undefined;
  proteinG?: number | null | undefined;
  carbsG?: number | null | undefined;
  fatG?: number | null | undefined;
  fiberG?: number | null | undefined;
};

export function hasItemNutrients(items: readonly ItemNutrientInput[]): boolean {
  return items.some((item) => typeof item.calories === "number" || typeof item.proteinG === "number");
}

export function scaleNutritionItem<T extends ItemNutrientInput>(item: T, factor: number): T {
  const safeFactor = Math.max(0, factor);
  return {
    ...item,
    ...(typeof item.calories === "number" ? { calories: Math.round(item.calories * safeFactor) } : {}),
    ...(typeof item.proteinG === "number" ? { proteinG: Math.round(item.proteinG * safeFactor * 10) / 10 } : {}),
    ...(typeof item.carbsG === "number" ? { carbsG: Math.round(item.carbsG * safeFactor * 10) / 10 } : {}),
    ...(typeof item.fatG === "number" ? { fatG: Math.round(item.fatG * safeFactor * 10) / 10 } : {}),
    ...(typeof item.fiberG === "number" ? { fiberG: Math.round(item.fiberG * safeFactor * 10) / 10 } : {}),
  };
}

export function recalculateMealFromItems<T extends ItemNutrientInput>(
  items: readonly T[],
  confidence: "high" | "medium" | "low" = "medium",
  uncertaintyReasons: readonly string[] = [],
) {
  let caloriesBest = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let fiberGTotal = 0;
  let hasFiber = false;

  for (const item of items) {
    if (typeof item.calories === "number") caloriesBest += item.calories;
    if (typeof item.proteinG === "number") proteinG += item.proteinG;
    if (typeof item.carbsG === "number") carbsG += item.carbsG;
    if (typeof item.fatG === "number") fatG += item.fatG;
    if (typeof item.fiberG === "number") {
      fiberGTotal += item.fiberG;
      hasFiber = true;
    }
  }

  // Derive reasonable bounds based on confidence
  const marginPct = confidence === "high" ? 0.1 : confidence === "low" ? 0.25 : 0.15;
  const caloriesLow = Math.max(0, Math.round(caloriesBest * (1 - marginPct)));
  const caloriesHigh = Math.max(caloriesBest, Math.round(caloriesBest * (1 + marginPct)));

  return {
    calories: {
      best: caloriesBest,
      low: caloriesLow,
      high: caloriesHigh,
    },
    macros: {
      proteinG: Math.round(proteinG * 10) / 10,
      carbsG: Math.round(carbsG * 10) / 10,
      fatG: Math.round(fatG * 10) / 10,
      fiberG: hasFiber ? Math.round(fiberGTotal * 10) / 10 : null,
    },
    confidence,
    uncertaintyReasons: [...uncertaintyReasons],
  };
}

export type MealTotalsInput = {
  calories: { best: number; low: number; high: number };
  macros: { proteinG: number; carbsG: number; fatG: number; fiberG: number | null };
  confidence?: "high" | "medium" | "low";
  uncertaintyReasons?: readonly string[];
};

export function applyItemPortionDelta<T extends ItemNutrientInput>(
  currentTotals: MealTotalsInput,
  oldItem: T,
  newItem: T,
): MealTotalsInput {
  const oldCal = typeof oldItem.calories === "number" ? oldItem.calories : 0;
  const newCal = typeof newItem.calories === "number" ? newItem.calories : 0;
  const deltaCal = newCal - oldCal;

  const oldProtein = typeof oldItem.proteinG === "number" ? oldItem.proteinG : 0;
  const newProtein = typeof newItem.proteinG === "number" ? newItem.proteinG : 0;
  const deltaProtein = newProtein - oldProtein;

  const oldCarbs = typeof oldItem.carbsG === "number" ? oldItem.carbsG : 0;
  const newCarbs = typeof newItem.carbsG === "number" ? newItem.carbsG : 0;
  const deltaCarbs = newCarbs - oldCarbs;

  const oldFat = typeof oldItem.fatG === "number" ? oldItem.fatG : 0;
  const newFat = typeof newItem.fatG === "number" ? newItem.fatG : 0;
  const deltaFat = newFat - oldFat;

  const oldFiber = typeof oldItem.fiberG === "number" ? oldItem.fiberG : 0;
  const newFiber = typeof newItem.fiberG === "number" ? newItem.fiberG : 0;
  const deltaFiber = newFiber - oldFiber;

  // Preserve original uncertainty spread around the new best estimate
  const originalSpreadLow = Math.max(0, currentTotals.calories.best - currentTotals.calories.low);
  const originalSpreadHigh = Math.max(0, currentTotals.calories.high - currentTotals.calories.best);

  const newBest = Math.max(0, Math.round(currentTotals.calories.best + deltaCal));
  const newLow = Math.max(0, newBest - originalSpreadLow);
  const newHigh = Math.max(newBest, newBest + originalSpreadHigh);

  const newProteinTotal = Math.max(0, Math.round((currentTotals.macros.proteinG + deltaProtein) * 10) / 10);
  const newCarbsTotal = Math.max(0, Math.round((currentTotals.macros.carbsG + deltaCarbs) * 10) / 10);
  const newFatTotal = Math.max(0, Math.round((currentTotals.macros.fatG + deltaFat) * 10) / 10);

  let newFiberTotal: number | null = currentTotals.macros.fiberG;
  if (typeof oldItem.fiberG === "number" || typeof newItem.fiberG === "number") {
    if (newFiberTotal !== null) {
      newFiberTotal = Math.max(0, Math.round((newFiberTotal + deltaFiber) * 10) / 10);
    } else if (newFiber > 0) {
      newFiberTotal = Math.round(newFiber * 10) / 10;
    }
  }

  return {
    calories: {
      best: newBest,
      low: newLow,
      high: newHigh,
    },
    macros: {
      proteinG: newProteinTotal,
      carbsG: newCarbsTotal,
      fatG: newFatTotal,
      fiberG: newFiberTotal,
    },
    confidence: currentTotals.confidence ?? "medium",
    uncertaintyReasons: currentTotals.uncertaintyReasons ? [...currentTotals.uncertaintyReasons] : [],
  };
}

export function formatAdjustedPortionDescription(baseDescription: string, factor: number): string {
  const multiplierMatch = baseDescription.match(/\((?:halved|one-quarter|(\d+(?:\.\d+)?)x)\)\s*$/i);
  let currentMultiplier = 1;
  if (multiplierMatch) {
    const matched = multiplierMatch[0].toLowerCase();
    if (matched.includes("halved")) currentMultiplier = 0.5;
    else if (matched.includes("one-quarter")) currentMultiplier = 0.25;
    else if (multiplierMatch[1]) currentMultiplier = parseFloat(multiplierMatch[1]);
  }
  const cleaned = baseDescription.replace(/\s*\((?:halved|one-quarter|\d+(?:\.\d+)?x)\)\s*$/i, "").trim();
  const nextMultiplier = Math.round(currentMultiplier * factor * 100) / 100;
  if (nextMultiplier === 1) return cleaned;
  if (nextMultiplier === 0.5) return `${cleaned} (halved)`;
  if (nextMultiplier === 0.25) return `${cleaned} (one-quarter)`;
  return `${cleaned} (${nextMultiplier}x)`;
}

