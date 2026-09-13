import { NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { HealthApiError, healthApiRequest } from "../../../../../lib/api";
import { resolveWebPendingMealScope } from "../../../../../lib/pending-scope";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const scopeKey = resolveWebPendingMealScope(session.user.id);
    const result = await healthApiRequest(
      `/v1/meals/pending/${id}?scopeKey=${encodeURIComponent(scopeKey)}`,
      {
        method: "GET",
        userId: session.user.id,
        signal: request.signal,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HealthApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load pending meal" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: RouteParams) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const scopeKey = resolveWebPendingMealScope(session.user.id);
    const body = (await request.json()) as Record<string, unknown>;
    const payload = {
      ...body,
      scopeKey,
    };

    const result = await healthApiRequest(`/v1/meals/pending/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
      userId: session.user.id,
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HealthApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update pending meal" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: RouteParams) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const scopeKey = resolveWebPendingMealScope(session.user.id);
    const result = await healthApiRequest(
      `/v1/meals/pending/${id}?scopeKey=${encodeURIComponent(scopeKey)}`,
      {
        method: "DELETE",
        userId: session.user.id,
        signal: request.signal,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HealthApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to cancel pending meal" },
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
