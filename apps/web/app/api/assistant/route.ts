import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { handleAssistantCommand } from "../../../lib/assistant";
import type { AssistantMeal, AssistantResult } from "../../../lib/assistant-types";
import { HealthApiError, healthApiRequest } from "../../../lib/api";

export const runtime = "nodejs";

const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
const commandSchema = z.object({
  action: z.literal("command").default("command"),
  message: z.string().trim().max(4_000).default(""),
  requestId: z.string().uuid(),
});
const mealPatchSchema = z.object({
  label: z.string().trim().min(1).max(300).optional(),
  caloriesBest: z.number().int().nonnegative().max(20_000).optional(),
  caloriesLow: z.number().int().nonnegative().max(20_000).optional(),
  caloriesHigh: z.number().int().nonnegative().max(20_000).optional(),
  proteinG: z.number().nonnegative().max(2_000).optional(),
  carbsG: z.number().nonnegative().max(3_000).optional(),
  fatG: z.number().nonnegative().max(2_000).optional(),
});
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), pendingId: z.string().uuid() }),
  z.object({ action: z.literal("cancel"), pendingId: z.string().uuid() }),
  z.object({ action: z.literal("edit"), pendingId: z.string().uuid(), patch: mealPatchSchema }),
]);

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) return handleMultipart(request);

    const payload = (await request.json()) as unknown;
    if (typeof payload === "object" && payload !== null && "action" in payload && payload.action !== "command") {
      return handleAction(actionSchema.parse(payload));
    }
    const command = commandSchema.parse(payload);
    if (!command.message) return NextResponse.json({ error: "A message is required" }, { status: 400 });
    return NextResponse.json(await runCommand(command));
  } catch (error) {
    return assistantError(error);
  }
}

async function handleMultipart(request: Request) {
  const form = await request.formData();
  const command = commandSchema.parse({ action: "command", message: form.get("message"), requestId: form.get("requestId") });
  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) throw new Error("Choose an image to upload");
  if (image.size > 8 * 1024 * 1024) throw new Error("Meal photos must be 8 MB or smaller");
  if (!imageTypes.includes(image.type as (typeof imageTypes)[number])) throw new Error("Use a JPEG, PNG, WebP, or HEIC image");
  const base64 = Buffer.from(await image.arrayBuffer()).toString("base64");
  return NextResponse.json(await runCommand({ ...command, image: { mimeType: image.type as (typeof imageTypes)[number], base64 } }));
}

async function runCommand(command: z.infer<typeof commandSchema> & { image?: { mimeType: (typeof imageTypes)[number]; base64: string } }) {
  return handleAssistantCommand(command, { request: healthApiRequest });
}

async function handleAction(action: z.infer<typeof actionSchema>) {
  if (action.action === "confirm") {
    const meal = await healthApiRequest<AssistantMeal>(`/v1/meals/pending/${action.pendingId}/confirm`, { method: "POST", body: "{}" });
    const result: AssistantResult = { kind: "meal_logged", message: `${meal.label} is logged. Your dashboard is updated.`, meal };
    return NextResponse.json(result);
  }
  if (action.action === "cancel") {
    await healthApiRequest(`/v1/meals/pending/${action.pendingId}`, { method: "DELETE" });
    const result: AssistantResult = { kind: "message", message: "Meal draft cancelled. Nothing was logged." };
    return NextResponse.json(result);
  }
  const meal = await healthApiRequest<AssistantMeal>(`/v1/meals/pending/${action.pendingId}`, { method: "PATCH", body: JSON.stringify(action.patch) });
  const result: AssistantResult = { kind: "meal_draft", message: "Estimate updated. Review it, then log when ready.", meal };
  return NextResponse.json(result);
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function assistantError(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: "That request wasn't valid", details: error.issues }, { status: 400 });
  if (error instanceof HealthApiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    return NextResponse.json({ error: error.message }, { status });
  }
  const message = error instanceof Error && /image|photo/i.test(error.message) ? error.message : "Ask ClawFit couldn't complete that request. Nothing was changed.";
  return NextResponse.json({ error: message }, { status: 400 });
}
