import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import middleware from "./middleware";
import { signOutAction } from "./app/actions";

const mockSignOut = vi.fn();
vi.mock("./auth", () => ({
  auth: (fn: any) => async (req: any) => {
    return fn(req);
  },
  signOut: (...args: any[]) => mockSignOut(...args),
}));

describe("web auth boundary & middleware", () => {
  it("redirects anonymous page navigation to /auth/signin with callbackUrl", async () => {
    const req = new NextRequest("http://localhost:3000/today");
    const res = await (middleware as any)(req);

    expect(res).toBeDefined();
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/auth/signin");
    expect(location).toContain("callbackUrl=%2Ftoday");
  });

  it("returns JSON 401 error for unauthenticated web API requests instead of HTML redirect", async () => {
    const req = new NextRequest("http://localhost:3000/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const res = await (middleware as any)(req);

    expect(res).toBeDefined();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  it("rejects cross-origin mutations on web API routes with 403 Forbidden", async () => {
    const req = new NextRequest("http://localhost:3000/api/assistant", {
      method: "POST",
      headers: {
        origin: "https://attacker.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "malicious" }),
    });
    (req as any).auth = {
      user: { id: "00000000-0000-0000-0000-000000000002", role: "primary" },
    };

    const res = await (middleware as any)(req);

    expect(res).toBeDefined();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "FORBIDDEN", message: "Cross-origin requests are forbidden" },
    });
  });

  it("allows same-origin mutations for authenticated users", async () => {
    const req = new NextRequest("http://localhost:3000/api/assistant", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "legitimate" }),
    });
    (req as any).auth = {
      user: { id: "00000000-0000-0000-0000-000000000002", role: "primary" },
    };

    const res = await (middleware as any)(req);
    expect(res.status).toBe(200);
  });

  it("permits authenticated user A and user B navigation through protected routes", async () => {
    const userAReq = new NextRequest("http://localhost:3000/workouts");
    (userAReq as any).auth = {
      user: { id: "user-a", role: "primary" },
    };
    const userARes = await (middleware as any)(userAReq);
    expect(userARes.status).toBe(200);

    const userBReq = new NextRequest("http://localhost:3000/workouts");
    (userBReq as any).auth = {
      user: { id: "user-b", role: "partner" },
    };
    const userBRes = await (middleware as any)(userBReq);
    expect(userBRes.status).toBe(200);
  });

  it("bypasses public static assets and auth pages", async () => {
    for (const url of [
      "http://localhost:3000/_next/static/chunk.js",
      "http://localhost:3000/favicon.ico",
      "http://localhost:3000/manifest.webmanifest",
      "http://localhost:3000/auth/signin",
      "http://localhost:3000/auth/error",
    ]) {
      const req = new NextRequest(url);
      const res = await (middleware as any)(req);
      expect(res.status).toBe(200);
    }
  });

  it("invokes signOutAction with redirect to /auth/signin", async () => {
    await signOutAction();
    expect(mockSignOut).toHaveBeenCalledWith({ redirectTo: "/auth/signin" });
  });
});
