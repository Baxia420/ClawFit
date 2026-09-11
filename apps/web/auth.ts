import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role?: string | undefined;
      displayName?: string | undefined;
      active?: boolean | undefined;
    } & DefaultSession["user"];
  }

  interface User {
    role?: string | undefined;
    displayName?: string | undefined;
    active?: boolean | undefined;
  }
}

const googleClientId = process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers:
    googleClientId && googleClientSecret
      ? [
          Google({
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          }),
        ]
      : [],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
  callbacks: {
    async signIn({ account, profile, user }) {
      if (account?.provider !== "google") {
        return false;
      }
      const providerAccountId = account.providerAccountId;
      const email = profile?.email ?? user.email;
      const emailVerified = profile?.email_verified === true;

      if (!emailVerified) {
        return "/auth/error?error=UNVERIFIED_EMAIL";
      }

      if (!providerAccountId || !email) {
        return "/auth/error?error=MissingProfileData";
      }

      const healthApiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
      const webToken = process.env.HEALTH_API_WEB_TOKEN;

      try {
        const res = await fetch(`${healthApiUrl}/v1/auth/google/resolve-or-link`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(webToken ? { authorization: `Bearer ${webToken}` } : {}),
          },
          body: JSON.stringify({
            providerAccountId,
            email,
            emailVerified,
            name: user.name ?? undefined,
            picture: user.image ?? undefined,
          }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
          const errorCode = body.error?.code ?? "AccessDenied";
          return `/auth/error?error=${encodeURIComponent(errorCode)}`;
        }

        const data = (await res.json()) as {
          resolved: boolean;
          user: { id: string; displayName?: string; role?: string; active?: boolean };
        };

        user.id = data.user.id;
        (user as Record<string, unknown>).role = data.user.role;
        (user as Record<string, unknown>).displayName = data.user.displayName;
        (user as Record<string, unknown>).active = data.user.active;

        return true;
      } catch (err) {
        console.error("[AUTH_RESOLVE_ERROR] Failed to resolve user with Health API", err);
        return "/auth/error?error=ServiceUnavailable";
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as Record<string, unknown>).role;
        token.displayName = (user as Record<string, unknown>).displayName;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        if (typeof token.role === "string") {
          session.user.role = token.role;
        }
        if (typeof token.displayName === "string") {
          session.user.displayName = token.displayName;
        }
      }
      return session;
    },
  },
  secret: (() => {
    const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
    // Build-time static collection only: if Next.js is performing phase-production-build and no secret is provided,
    // provide an isolated placeholder that cannot be reached at runtime.
    if (process.env.NEXT_PHASE === "phase-production-build" && !s) {
      return "build-time-placeholder-secret-not-used-at-runtime-0000";
    }
    if (!s || s.length < 32) {
      throw new Error("INVALID_AUTH_SECRET: AUTH_SECRET must be configured with at least 32 characters");
    }
    const assertionSecret = process.env.WEB_ASSERTION_SIGNING_SECRET ?? process.env.HEALTH_API_AUTH_SECRET;
    const machineToken = process.env.HEALTH_API_WEB_TOKEN;
    if (assertionSecret && s === assertionSecret) {
      throw new Error("INVALID_AUTH_SECRET: AUTH_SECRET must not be reused as WEB_ASSERTION_SIGNING_SECRET");
    }
    if (machineToken && s === machineToken) {
      throw new Error("INVALID_AUTH_SECRET: AUTH_SECRET must not be reused as HEALTH_API_WEB_TOKEN");
    }
    return s;
  })(),
  trustHost: true,
});

