import type { AssistantMeal, AssistantResult, AssistantWorkout } from "./assistant-types";

type RequestInitWithBody = Omit<RequestInit, "body"> & { body?: string };

export type AssistantHealthClient = {
  request<T>(path: string, init?: RequestInitWithBody): Promise<T>;
};

type CommandInput = {
  message: string;
  requestId: string;
  image?: { mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic"; base64: string };
};

type DailyNutrition = {
  totals: { caloriesBest: number; proteinG: number; carbsG: number; fatG: number };
  meals: { label: string }[];
};

type Settings = { timezone: string };
type TrendRow = { protein_g: number | string };
type ExerciseSet = { weightKg: number | null; estimatedOneRepMax: number | null };

export async function handleAssistantCommand(
  input: CommandInput,
  client: AssistantHealthClient,
  now = new Date(),
): Promise<AssistantResult> {
  const message = input.message.trim();
  const normalized = message.toLocaleLowerCase();

  if (isConfirmation(normalized)) {
    const { pending } = await client.request<{ pending: AssistantMeal | null }>("/v1/meals/pending/latest");
    if (!pending) return { kind: "message", message: "There isn't an unconfirmed meal draft to log." };
    const meal = await client.request<AssistantMeal>(`/v1/meals/pending/${pending.id}/confirm`, { method: "POST", body: "{}" });
    return { kind: "meal_logged", message: `${meal.label} is logged. Your totals are up to date.`, meal };
  }

  if (/^(cancel|discard)( it| meal)?[.!]?$/i.test(message)) {
    const { pending } = await client.request<{ pending: AssistantMeal | null }>("/v1/meals/pending/latest");
    if (!pending) return { kind: "message", message: "There isn't an unconfirmed meal draft to cancel." };
    await client.request(`/v1/meals/pending/${pending.id}`, { method: "DELETE" });
    return { kind: "message", message: "Meal draft cancelled. Nothing was logged." };
  }

  if (/what (did i eat|have i eaten)|today'?s (food|meals)|calories today/.test(normalized)) {
    const settings = await client.request<Settings>("/v1/settings");
    const date = dateInTimeZone(now, settings.timezone);
    const daily = await client.request<DailyNutrition>(`/v1/nutrition/daily?date=${date}&timezone=${encodeURIComponent(settings.timezone)}`);
    const labels = daily.meals.map((meal) => meal.label).join(", ");
    return {
      kind: "nutrition",
      message: daily.meals.length ? `Today you've logged ${labels}.` : "You haven't logged any meals today.",
      nutrition: {
        calories: Math.round(daily.totals.caloriesBest),
        proteinG: Math.round(daily.totals.proteinG),
        carbsG: Math.round(daily.totals.carbsG),
        fatG: Math.round(daily.totals.fatG),
        mealCount: daily.meals.length,
      },
    };
  }

  if (/protein.*(week|7 days)|(week|7 days).*protein/.test(normalized)) {
    const rows = await client.request<TrendRow[]>("/v1/nutrition/trend?days=7");
    const total = rows.reduce((sum, row) => sum + Number(row.protein_g), 0);
    const average = rows.length ? Math.round(total / rows.length) : 0;
    return {
      kind: "nutrition",
      message: rows.length ? `Your protein averaged ${average} g across ${rows.length} logged days this week.` : "There isn't enough logged nutrition data for a weekly protein view yet.",
      nutrition: { calories: 0, proteinG: average, carbsG: 0, fatG: 0, mealCount: rows.length },
    };
  }

  if (/what (have i done|did i do).*(workout|session)|current workout|active workout/.test(normalized)) {
    const workout = await client.request<AssistantWorkout | null>("/v1/workouts/active");
    return workout
      ? { kind: "workout", message: `${workout.workout.name}: ${workout.setCount} sets and ${Math.round(workout.volumeKg).toLocaleString()} kg volume so far.`, workout }
      : { kind: "message", message: "There isn't an active workout right now. Try “starting push”." };
  }

  const startMatch = message.match(/^start(?:ing)?\s+(.+?)[.!]?$/i);
  if (startMatch?.[1]) {
    const workout = await client.request<AssistantWorkout>("/v1/workouts", {
      method: "POST",
      body: JSON.stringify({ name: titleCase(startMatch[1]), idempotencyKey: `web_${input.requestId}` }),
    });
    return { kind: "workout", message: `${workout.workout.name} started. Send a set like “bench 80 x 8”.`, workout };
  }

  const repeatMatch = message.match(/^(\d{1,3})\s+(?:again|more)[.!]?$/i);
  if (repeatMatch?.[1]) {
    const workout = await requireActiveWorkout(client);
    if (!workout) return { kind: "message", message: "Start a workout before logging a set." };
    const latest = latestWorkoutSet(workout);
    if (!latest) return { kind: "message", message: "Log one complete set first so I know which exercise and weight to repeat." };
    await client.request(`/v1/workouts/${workout.workout.id}/sets`, {
      method: "POST",
      body: JSON.stringify({ exerciseName: latest.exerciseName, weightKg: latest.weightKg, reps: Number(repeatMatch[1]), idempotencyKey: `web_${input.requestId}` }),
    });
    const refreshed = await requireActiveWorkout(client);
    return { kind: "set_logged", message: `${latest.exerciseName}: ${latest.weightKg ?? "bodyweight"} × ${repeatMatch[1]} logged.`, ...(refreshed ? { workout: refreshed } : {}) };
  }

  const setMatch = message.match(/^(.+?)\s+(bodyweight|bw|\d+(?:\.\d+)?)\s*(?:kg\s*)?[x×]\s*(\d{1,3})[.!]?$/i);
  if (setMatch?.[1] && setMatch[2] && setMatch[3]) {
    const workout = await requireActiveWorkout(client);
    if (!workout) return { kind: "message", message: "Start a workout before logging a set." };
    const weightKg = /^(bodyweight|bw)$/i.test(setMatch[2]) ? null : Number(setMatch[2]);
    const exerciseName = titleCase(setMatch[1]);
    await client.request(`/v1/workouts/${workout.workout.id}/sets`, {
      method: "POST",
      body: JSON.stringify({ exerciseName, weightKg, reps: Number(setMatch[3]), idempotencyKey: `web_${input.requestId}` }),
    });
    const refreshed = await requireActiveWorkout(client);
    return { kind: "set_logged", message: `${exerciseName}: ${weightKg ?? "bodyweight"} × ${setMatch[3]} logged.`, ...(refreshed ? { workout: refreshed } : {}) };
  }

  const bestMatch = message.match(/best\s+(.+?)(?:\s+recently)?[?!.]*$/i);
  if (bestMatch?.[1]) {
    const name = bestMatch[1].replace(/^(my|the)\s+/i, "").trim();
    const sets = await client.request<ExerciseSet[]>(`/v1/exercises/history?name=${encodeURIComponent(name)}&limit=200`);
    const bestWeightKg = Math.max(0, ...sets.map((set) => set.weightKg ?? 0));
    const bestEstimatedOneRepMaxKg = Math.max(0, ...sets.map((set) => set.estimatedOneRepMax ?? 0));
    return {
      kind: "exercise",
      message: sets.length ? `Your best recent ${name} was ${bestWeightKg} kg; best estimated 1RM was ${bestEstimatedOneRepMaxKg} kg.` : `I couldn't find any logged ${name} sets.`,
      exercise: { name, bestWeightKg, bestEstimatedOneRepMaxKg, setCount: sets.length },
    };
  }

  if (input.image || looksLikeMeal(normalized)) {
    const estimation = await client.request<{ estimate: {
      label: string;
      items: { name: string; portionDescription: string }[];
      calories: { best: number; low: number; high: number };
      macros: { proteinG: number; carbsG: number; fatG: number; fiberG: number | null };
      confidence: "high" | "medium" | "low";
      uncertaintyReasons: string[];
    } }>("/v1/nutrition/estimate", {
      method: "POST",
      body: JSON.stringify({ text: message, ...(input.image ? { image: input.image } : {}) }),
    });
    const pending = await client.request<AssistantMeal>("/v1/meals/pending", {
      method: "POST",
      body: JSON.stringify({
        ...estimation.estimate,
        occurredAt: now.toISOString(),
        source: input.image ? "photo" : "text",
        rawUserText: message || null,
        idempotencyKey: `web_${input.requestId}`,
        expiresInSeconds: 7200,
      }),
    });
    return { kind: "meal_draft", message: "Here's the estimate. Review it before anything is logged.", meal: pending };
  }

  return {
    kind: "message",
    message: "I can check today's food, review weekly protein, start or inspect a workout, log sets, look up an exercise best, and estimate a meal or food photo.",
  };
}

function isConfirmation(message: string) {
  return /^(log|save|track|record)( it| meal)?[.!]?$/.test(message) || /^(yes|yep|yeah|confirm|do it|go ahead)[.!]?$/.test(message);
}

function looksLikeMeal(message: string) {
  return /\b(ate|eaten|had|breakfast|lunch|dinner|snack|meal|eggs?|toast|rice|chicken|beef|fish|noodles?|bread|oats?|yogurt|fruit|banana|apple|sandwich|burger|pizza)\b/.test(message);
}

async function requireActiveWorkout(client: AssistantHealthClient) {
  return client.request<AssistantWorkout | null>("/v1/workouts/active");
}

function latestWorkoutSet(workout: AssistantWorkout) {
  const candidates = workout.exercises.flatMap((exercise) => exercise.sets.map((set) => ({ ...set, exerciseName: exercise.name })));
  return candidates.sort((left, right) => {
    if (left.occurredAt && right.occurredAt) return right.occurredAt.localeCompare(left.occurredAt);
    return right.setNumber - left.setNumber;
  })[0];
}

function titleCase(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateInTimeZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
