const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";

export async function healthApi<T>(path: string): Promise<T> {
  return healthApiRequest<T>(path);
}

export class HealthApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HealthApiError";
  }
}

export class HealthApiNetworkError extends HealthApiError {
  constructor() {
    super("ClawFit's health service is temporarily unavailable. Nothing was changed.", 503);
    this.name = "HealthApiNetworkError";
  }
}

export async function healthApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.HEALTH_API_TOKEN;
  if (!token) throw new HealthApiError("The Health API is not configured", 503);
  let response: Response;
  try {
    response = await fetch(new URL(path, apiUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(50_000),
    });
  } catch (error) {
    logNetworkFailure(path, error);
    throw new HealthApiNetworkError();
  }
  let payload: { error?: { message?: string } } & T;
  try {
    payload = (await response.json()) as { error?: { message?: string } } & T;
  } catch (error) {
    logNetworkFailure(path, error, response.status);
    throw new HealthApiNetworkError();
  }
  if (!response.ok) throw new HealthApiError(payload.error?.message ?? "The Health API request failed", response.status);
  return payload;
}

function logNetworkFailure(path: string, error: unknown, status?: number) {
  console.error("[HEALTH_API_NETWORK] request failed", { path, ...(status === undefined ? {} : { status }) }, error);
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

export type Settings = {
  calorieTarget: number;
  proteinTargetG: number;
  timezone: string;
  preferredUnits: "metric" | "imperial";
};

export type NotificationType = "meal_reminder" | "workout_reminder" | "evening_progress" | "unfinished_workout" | "daily_summary" | "weekly_summary";

export type NotificationPreference = {
  id?: string;
  type: NotificationType;
  enabled: boolean;
  timeLocal: string | null;
  timezone: string;
  daysOfWeek: number[];
  deliveryChannel: "web_push" | "whatsapp" | "both";
  configuration: Record<string, string | number | boolean>;
};

export function localDate(timeZone = process.env.APP_TIMEZONE ?? "Asia/Kuala_Lumpur") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatLocalDate(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-MY", { timeZone, day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatLocalTime(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-MY", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}
