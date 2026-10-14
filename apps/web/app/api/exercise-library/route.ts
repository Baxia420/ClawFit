import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { libraryQuerySchema, libraryIdSchema, customExerciseCreateSchema, customExerciseUpdateSchema } from "@clawfit/health-core";
import { auth } from "../../../auth";
import { HealthApiError, healthApiRequest } from "../../../lib/api";
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("favorite"), id: libraryIdSchema, favorite: z.boolean() }),
  z.object({ action: z.literal("create"), data: customExerciseCreateSchema }),
  z.object({ action: z.literal("update"), id: libraryIdSchema, data: customExerciseUpdateSchema }),
]);
function failure(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Check the entered values" }, { status: 400 });
  if (error instanceof HealthApiError) return NextResponse.json({ error: error.message }, { status: error.status >= 500 ? 502 : error.status });
  return NextResponse.json({ error: "Exercise library unavailable. Try again." }, { status: 503 });
}
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    let path: string;
    if (params.has("id")) {
      const id = libraryIdSchema.parse(params.get("id"));
      path = `/v1/exercise-library/${encodeURIComponent(id)}${params.get("history") === "true" ? "/history" : ""}`;
    } else {
      const query = libraryQuerySchema.parse(Object.fromEntries(params));
      const serialized = new URLSearchParams(Object.entries(query).map(([key,value]) => [key, String(value)]));
      path = `/v1/exercise-library?${serialized}`;
    }
    return NextResponse.json(await healthApiRequest(path, { userId: session.user.id }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
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
    const path = command.action === "create" ? "/v1/exercise-library/custom" : `/v1/exercise-library/${encodeURIComponent(command.id)}${command.action === "favorite" ? "/favorite" : ""}`;
    const body = command.action === "favorite" ? { favorite: command.favorite } : command.data;
    return NextResponse.json(await healthApiRequest(path, { method: command.action === "create" ? "POST" : "PUT", body: JSON.stringify(body), userId: session.user.id }));
  } catch (error) { return failure(error); }
}
