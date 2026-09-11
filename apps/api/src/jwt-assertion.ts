import { jwtVerify } from "jose";

export interface VerifiedWebAssertion {
  userId: string;
  role?: string | undefined;
  email?: string | undefined;
}

export interface VerifyAssertionOptions {
  secret: string;
  token: string;
  expectedIssuer?: string | undefined;
  expectedAudience?: string | undefined;
  nowInSeconds?: number | undefined;
}

/**
 * Clock tolerance in seconds to accommodate slight clock skew between Next.js and Fastify processes.
 */
export const ASSERTION_CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Maximum permitted assertion lifetime (exp - iat) in seconds.
 */
export const ASSERTION_MAX_LIFETIME_SECONDS = 60;

export async function verifyWebAssertion(options: VerifyAssertionOptions): Promise<VerifiedWebAssertion> {
  if (!options.secret || options.secret.length < 32) {
    throw new Error("INVALID_SIGNING_SECRET: Assertion secret must be configured with at least 32 characters");
  }
  if (!options.token || typeof options.token !== "string") {
    throw new Error("MISSING_ASSERTION_TOKEN: A signed assertion token is required");
  }

  const expectedIssuer = options.expectedIssuer ?? "clawfit-web";
  const expectedAudience = options.expectedAudience ?? "clawfit-health-api";
  const secretKey = new TextEncoder().encode(options.secret);

  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    algorithms: ["HS256"],
    issuer: expectedIssuer,
    audience: expectedAudience,
    requiredClaims: ["sub", "iss", "aud", "iat", "exp"],
    clockTolerance: ASSERTION_CLOCK_TOLERANCE_SECONDS,
  };
  if (options.nowInSeconds !== undefined) {
    verifyOptions.currentDate = new Date(options.nowInSeconds * 1000);
  }

  const { payload, protectedHeader } = await jwtVerify(options.token, secretKey, verifyOptions);

  if (protectedHeader.alg !== "HS256") {
    throw new Error(`UNSUPPORTED_ALGORITHM: Expected HS256, received ${protectedHeader.alg}`);
  }

  const { sub, iat, exp } = payload;

  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw new Error("INVALID_ASSERTION_SUBJECT: Assertion subject must be a non-empty string");
  }

  if (typeof iat !== "number" || !Number.isFinite(iat) || typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new Error("INVALID_TIMESTAMPS: iat and exp must be valid numeric timestamps");
  }

  const lifetime = exp - iat;
  if (lifetime <= 0 || lifetime > ASSERTION_MAX_LIFETIME_SECONDS) {
    throw new Error(
      `EXCESSIVE_LIFETIME: Assertion lifetime of ${lifetime}s exceeds maximum permitted ${ASSERTION_MAX_LIFETIME_SECONDS}s`,
    );
  }

  const now = options.nowInSeconds ?? Math.floor(Date.now() / 1000);

  if (iat > now + ASSERTION_CLOCK_TOLERANCE_SECONDS) {
    throw new Error("FUTURE_ISSUED: Assertion issue time is in the future");
  }

  if (exp < now - ASSERTION_CLOCK_TOLERANCE_SECONDS) {
    throw new Error("EXPIRED_ASSERTION: Assertion has expired");
  }

  return {
    userId: sub.trim(),
    role: typeof payload.role === "string" ? payload.role : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

