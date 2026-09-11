import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { formatLocalDate, formatLocalTime, HealthApiError, HealthApiNetworkError, healthApi, healthApiRequest, createWebAssertion } from "./api";

vi.mock("../auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "00000000-0000-0000-0000-000000000002", role: "primary", displayName: "Primary User" },
  }),
}));

describe("web Health API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("turns fetch failures into a typed, user-safe availability error", async () => {
    vi.stubEnv("HEALTH_API_WEB_TOKEN", "test-token-that-is-at-least-24-chars");
    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1")));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await healthApiRequest("/v1/settings").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HealthApiNetworkError);
    expect((error as Error).message).toBe("ClawFit's health service is temporarily unavailable. Nothing was changed.");
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalledWith("[HEALTH_API_NETWORK] request failed", { path: "/v1/settings" }, expect.any(TypeError));
  });

  it("does not turn missing configuration into believable empty data", async () => {
    vi.stubEnv("HEALTH_API_WEB_TOKEN", "");
    vi.stubEnv("HEALTH_API_AUTH_SECRET", "");

    const error = await healthApi("/v1/settings").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HealthApiError);
    expect((error as HealthApiError).status).toBe(503);
  });

  it("formats timestamps in the user's configured timezone", () => {
    const timestamp = "2026-08-18T16:30:00.000Z";

    expect(formatLocalDate(timestamp, "Asia/Kuala_Lumpur")).toBe("19 Aug 2026");
    expect(formatLocalTime(timestamp, "Asia/Kuala_Lumpur")).toBe("00:30");
  });

  it("signs short-lived JWT assertions with sub, issuer, audience, and 60s expiration", async () => {
    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
    vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");
    const token = await createWebAssertion("user-123", "primary", "user@example.com");
    const claims = decodeJwt(token);

    expect(claims.sub).toBe("user-123");
    expect(claims.iss).toBe("clawfit-web");
    expect(claims.aud).toBe("clawfit-health-api");
    expect(claims.role).toBe("primary");
    expect(claims.email).toBe("user@example.com");
    expect(claims.exp).toBeDefined();
    expect(claims.iat).toBeDefined();
    expect(claims.exp! - claims.iat!).toBe(60);
  });

  it("fails closed when assertion secret is missing, too short, or reuses machine token", async () => {
    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "");
    vi.stubEnv("HEALTH_API_AUTH_SECRET", "");
    vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");
    await expect(createWebAssertion("user-123")).rejects.toThrow("WEB_ASSERTION_SIGNING_SECRET is not configured");

    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "too-short-secret");
    await expect(createWebAssertion("user-123")).rejects.toThrow("WEB_ASSERTION_SIGNING_SECRET is not configured");

    // Prohibit reusing machine token as assertion signing secret
    const machineToken = "reused-token-at-least-32-characters-long";
    vi.stubEnv("HEALTH_API_WEB_TOKEN", machineToken);
    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", machineToken);
    await expect(createWebAssertion("user-123")).rejects.toThrow("WEB_ASSERTION_SIGNING_SECRET is not configured");
  });

  it("attaches signed bearer assertion on outgoing healthApiRequest calls", async () => {
    vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
    vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await healthApiRequest("/v1/settings");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const headers = (callArgs![1] as RequestInit & { headers: Record<string, string> }).headers;
    const authHeader = headers.authorization;
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Bearer eyJ/);

    const token = authHeader!.replace("Bearer ", "");
    const claims = decodeJwt(token);
    expect(claims.sub).toBe("00000000-0000-0000-0000-000000000002");
    expect(claims.iss).toBe("clawfit-web");
    expect(claims.aud).toBe("clawfit-health-api");
  });

  it("supports machine token requests when explicitly requested", async () => {
    const machineToken = "machine-token-at-least-24-chars";
    vi.stubEnv("HEALTH_API_WEB_TOKEN", machineToken);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await healthApiRequest("/v1/auth/google/resolve-or-link", { useMachineToken: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const headers = (callArgs![1] as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe(`Bearer ${machineToken}`);
  });
});
