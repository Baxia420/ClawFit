import { SignJWT } from "jose";
import { auth } from "../auth";

const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";

export class HealthApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
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

export async function createWebAssertion(userId: string, role?: string, email?: string): Promise<string> {
  const secret = process.env.WEB_ASSERTION_SIGNING_SECRET ?? process.env.HEALTH_API_AUTH_SECRET;
  const machineToken = process.env.HEALTH_API_WEB_TOKEN;
  const sessionSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32 || (machineToken && secret === machineToken) || (sessionSecret && secret === sessionSecret)) {
    throw new HealthApiError("WEB_ASSERTION_SIGNING_SECRET is not configured or improperly configured", 503);
  }
  return new SignJWT({
    sub: userId,
    ...(role ? { role } : {}),
    ...(email ? { email } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("clawfit-web")
    .setAudience("clawfit-health-api")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
}

export type HealthApiOptions = RequestInit & {
  userId?: string;
  userRole?: string;
  userEmail?: string;
  useMachineToken?: boolean;
};

export async function healthApi<T>(path: string, options?: HealthApiOptions): Promise<T> {
  return healthApiRequest<T>(path, options);
}

export async function healthApiRequest<T>(path: string, init: HealthApiOptions = {}): Promise<T> {
  const machineToken = process.env.HEALTH_API_WEB_TOKEN;
  const assertionSecret = process.env.WEB_ASSERTION_SIGNING_SECRET ?? process.env.HEALTH_API_AUTH_SECRET;

  if (init.useMachineToken) {
    if (!machineToken) {
      throw new HealthApiError("The Health API machine token is not configured", 503);
    }
  } else if (!assertionSecret) {
    throw new HealthApiError("The Health API web authentication is not configured", 503);
  }

  let authHeader =
    init.headers && "authorization" in (init.headers as Record<string, string>)
      ? (init.headers as Record<string, string>)["authorization"]
      : undefined;

  if (!authHeader) {
    if (init.useMachineToken) {
      if (!machineToken) throw new HealthApiError("The Health API is not configured", 503);
      authHeader = `Bearer ${machineToken}`;
    } else {
      let targetUserId = init.userId;
      let targetRole = init.userRole;
      let targetEmail = init.userEmail;

      if (!targetUserId) {
        try {
          const session = await auth();
          if (session?.user?.id) {
            targetUserId = session.user.id;
            targetRole = session.user.role;
            targetEmail = session.user.email ?? undefined;
          }
        } catch {
          // auth() called outside request context or unauthenticated
        }
      }

      if (!targetUserId) {
        throw new HealthApiError("Authentication required", 401);
      }

      const assertion = await createWebAssertion(targetUserId, targetRole, targetEmail);
      authHeader = `Bearer ${assertion}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, apiUrl), {
      ...init,
      headers: {
        authorization: authHeader,
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
  let payload: { error?: { message?: string; code?: string } } & T;
  try {
    payload = (await response.json()) as { error?: { message?: string; code?: string } } & T;
  } catch (error) {
    logNetworkFailure(path, error, response.status);
    throw new HealthApiNetworkError();
  }
  if (!response.ok) throw new HealthApiError(payload.error?.message ?? "The Health API request failed", response.status, payload.error?.code);
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
};

export async function fetchDailyNutrition(options?: { date?: string; timezone?: string; userId?: string }): Promise<{
  meals: Meal[];
  totals: { caloriesBest: number; caloriesLow: number; caloriesHigh: number; proteinG: number; carbsG: number; fatG: number };
  date: string;
}> {
  const params = new URLSearchParams();
  if (options?.date) params.set("date", options.date);
  if (options?.timezone) params.set("timezone", options.timezone);
  const query = params.toString() ? `?${params.toString()}` : "";
  return healthApi(`/v1/nutrition/daily${query}`, options?.userId ? { userId: options.userId } : undefined);
}

export async function fetchSettings(options?: { userId?: string }): Promise<Settings> {
  return healthApi<Settings>("/v1/settings", options?.userId ? { userId: options.userId } : undefined);
}

export async function updateSettings(settings: Partial<Settings>, options?: { userId?: string }): Promise<Settings> {
  return healthApi<Settings>("/v1/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
    ...(options?.userId ? { userId: options.userId } : {}),
  });
}

export async function fetchRecentMeals(options?: { limit?: number; userId?: string }): Promise<{ meals: Meal[] }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return healthApi(`/v1/meals/recent${query}`, options?.userId ? { userId: options.userId } : undefined);
}

export async function fetchWorkouts(options?: { userId?: string }): Promise<{ workouts: Workout[] }> {
  return healthApi("/v1/workouts", options?.userId ? { userId: options.userId } : undefined);
}

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

export type {
  TogetherResponse,
  TogetherMemberProgress,
  TogetherMealSummary,
  TogetherWorkoutSummary,
  TogetherTrendPoint,
} from "@clawfit/health-core";

export async function fetchTogetherData(options?: {
  date?: string;
  days?: number;
}): Promise<import("@clawfit/health-core").TogetherResponse> {
  const params = new URLSearchParams();
  if (options?.date) params.set("date", options.date);
  if (options?.days) params.set("days", String(options.days));
  const query = params.toString() ? `?${params.toString()}` : "";
  return healthApi<import("@clawfit/health-core").TogetherResponse>(
    `/v1/together${query}`,
  );
}
