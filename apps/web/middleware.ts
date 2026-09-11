import { auth } from "./auth";
import { NextResponse, type NextRequest } from "next/server";

export default auth((req) => {
  const nextReq = req as unknown as NextRequest & { auth?: { user?: unknown } };
  const { pathname } = nextReq.nextUrl;
  const isAuthPage = pathname.startsWith("/auth");
  const isAuthApi = pathname.startsWith("/api/auth");
  const isPublicStatic =
    pathname.startsWith("/_next") ||
    pathname.startsWith("/icon") ||
    pathname.startsWith("/apple-icon") ||
    pathname.startsWith("/pwa-icon") ||
    pathname.startsWith("/pwa-maskable") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico";

  if (isPublicStatic || isAuthPage || isAuthApi) {
    return NextResponse.next();
  }

  // Cross-origin mutation protection for API routes
  if (pathname.startsWith("/api/")) {
    const method = nextReq.method?.toUpperCase();
    if (method && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const origin = nextReq.headers.get("origin");
      if (origin && origin !== nextReq.nextUrl.origin) {
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Cross-origin requests are forbidden" } },
          { status: 403 },
        );
      }
    }

    if (!nextReq.auth?.user) {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  // Protected page navigation: redirect to sign-in
  if (!nextReq.auth?.user) {
    const signInUrl = new URL("/auth/signin", nextReq.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", nextReq.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|auth|icon|apple-icon|pwa-icon|pwa-maskable|manifest\\.webmanifest|favicon\\.ico).*)",
  ],
};
