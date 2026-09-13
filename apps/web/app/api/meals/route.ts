import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { HealthApiError, healthApiRequest } from "../../../lib/api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const result = await healthApiRequest("/v1/meals", {
      method: "POST",
      body: JSON.stringify(payload),
      userId: session.user.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof HealthApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to log meal" },
      { status: 500 },
    );
  }
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
