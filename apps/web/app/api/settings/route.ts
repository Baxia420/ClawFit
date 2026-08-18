import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { HealthApiError, healthApiRequest } from "../../../lib/api";

const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid IANA timezone");
const settingsSchema = z.object({
  calorieTarget: z.number().int().min(500).max(10_000),
  proteinTargetG: z.number().min(10).max(1_000),
  timezone: timezoneSchema,
  preferredUnits: z.enum(["metric", "imperial"]),
});
const notificationSchema = z.object({
  type: z.enum(["meal_reminder", "workout_reminder", "evening_progress", "unfinished_workout", "daily_summary", "weekly_summary"]),
  enabled: z.boolean(),
  timeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  timezone: timezoneSchema,
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length),
  deliveryChannel: z.enum(["web_push", "whatsapp", "both"]),
  configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export async function PATCH(request: Request) {
  return proxyValidated(request, settingsSchema, "/v1/settings", "PATCH");
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  try {
    const preference = notificationSchema.parse(await request.json());
    return NextResponse.json(await healthApiRequest(`/v1/notification-preferences/${preference.type}`, { method: "PUT", body: JSON.stringify(preference) }));
  } catch (error) {
    return settingsError(error);
  }
}

async function proxyValidated(request: Request, schema: typeof settingsSchema, path: string, method: string) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  try {
    const payload = schema.parse(await request.json());
    return NextResponse.json(await healthApiRequest(path, { method, body: JSON.stringify(payload) }));
  } catch (error) {
    return settingsError(error);
  }
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try { return new URL(origin).host === host; } catch { return false; }
}

function settingsError(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: "Check the highlighted settings", details: error.issues }, { status: 400 });
  if (error instanceof HealthApiError) return NextResponse.json({ error: error.message }, { status: error.status >= 500 ? 502 : error.status });
  return NextResponse.json({ error: "Settings could not be saved" }, { status: 500 });
}
