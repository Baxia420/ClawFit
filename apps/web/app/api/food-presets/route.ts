import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { HealthApiError, healthApiRequest } from "../../../lib/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? "";
    const result = await healthApiRequest(`/v1/food-presets?query=${encodeURIComponent(query)}`, {
      method: "GET",
      userId: session.user.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HealthApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to fetch presets" }, { status: 500 });
  }
}
