const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";

export async function healthApi<T>(path: string): Promise<T | null> {
  const token = process.env.HEALTH_API_TOKEN;
  if (!token) return null;
  try {
    const response = await fetch(new URL(path, apiUrl), { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export type Meal = {
  id: string;
  occurredAt: string;
  label: string;
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  confidence: "high" | "medium" | "low";
};

export type Workout = {
  workout: { id: string; name: string; status: string; startedAt: string; finishedAt: string | null };
  exercises: { id: string; name: string; sets: { id: string; setNumber: number; weightKg: number | null; reps: number; estimatedOneRepMax: number | null }[] }[];
  volumeKg: number;
  setCount: number;
};

export function localDate(timeZone = process.env.APP_TIMEZONE ?? "Asia/Kuala_Lumpur") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

