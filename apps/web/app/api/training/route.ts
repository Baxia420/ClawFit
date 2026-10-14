import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { routineCreateSchema, routineUpdateSchema, scheduleInputSchema, startWorkoutSchema, trainingDateSchema, weightEntrySchema, weightGoalSchema, workoutSetInputSchema, workoutSetPatchSchema } from "@clawfit/health-core";
import { auth } from "../../../auth";
import { HealthApiError, healthApiRequest } from "../../../lib/api";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("weight"), day: trainingDateSchema, data: weightEntrySchema }),
  z.object({ action: z.literal("goal"), data: weightGoalSchema }),
  z.object({ action: z.literal("createRoutine"), data: routineCreateSchema }),
  z.object({ action: z.literal("updateRoutine"), id: z.string().uuid(), data: routineUpdateSchema }),
  z.object({ action: z.literal("schedule"), weekday: z.number().int().min(1).max(7), data: scheduleInputSchema }),
  z.object({ action: z.literal("start"), data: startWorkoutSchema }),
  z.object({ action: z.literal("set"), id: z.string().uuid(), data: workoutSetInputSchema }),
  z.object({ action: z.literal("editSet"), id: z.string().uuid(), data: workoutSetPatchSchema }),
  z.object({ action: z.literal("finish"), id: z.string().uuid() }),
]);
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  if (origin) {
    try { if (new URL(origin).host !== request.headers.get("host")) return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 }); }
    catch { return NextResponse.json({ error: "Invalid origin" }, { status: 403 }); }
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const command = commandSchema.parse(await request.json());
    let path: string, method: string = "PUT", data: unknown = "data" in command ? command.data : {};
    switch (command.action) {
      case "weight": path = `/v1/training/weight/${command.day}`; break;
      case "goal": path = "/v1/training/weight/goal"; break;
      case "createRoutine": path = "/v1/training/routines"; method = "POST"; break;
      case "updateRoutine": path = `/v1/training/routines/${command.id}`; break;
      case "schedule": path = `/v1/training/schedule/${command.weekday}`; break;
      case "start": path = "/v1/workouts"; method = "POST"; break;
      case "set": path = `/v1/workouts/${command.id}/sets`; method = "POST"; break;
      case "editSet": path = `/v1/workout-sets/${command.id}`; method = "PATCH"; break;
      case "finish": path = `/v1/workouts/${command.id}/finish`; method = "POST"; data = {}; break;
    }
    const result = await healthApiRequest(path, { method, body: JSON.stringify(data), userId: session.user.id });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Check the entered values" }, { status: 400 });
    if (error instanceof HealthApiError) return NextResponse.json({ error: error.message }, { status: error.status >= 500 ? 502 : error.status });
    return NextResponse.json({ error: "Could not save. Your entries are still here; retry." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("plans") === "true") return NextResponse.json(await healthApiRequest("/v1/training/plans", { userId: session.user.id }), { headers: { "Cache-Control": "private, no-store" } });
    const name = z.string().trim().min(1).max(160).parse(url.searchParams.get("exercise"));
    const before = z.iso.datetime().parse(url.searchParams.get("before"));
    return NextResponse.json(await healthApiRequest(`/v1/exercises/previous?${new URLSearchParams({ name, before })}`, { userId: session.user.id }));
  } catch { return NextResponse.json({ error: "Previous performance unavailable" }, { status: 400 }); }
}
