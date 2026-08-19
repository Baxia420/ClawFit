import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthApiNetworkError, healthApiRequest } from "./api";

describe("web Health API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("turns fetch failures into a typed, user-safe availability error", async () => {
    vi.stubEnv("HEALTH_API_TOKEN", "test-token-that-is-at-least-24-chars");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1")));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await healthApiRequest("/v1/settings").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HealthApiNetworkError);
    expect((error as Error).message).toBe("ClawFit's health service is temporarily unavailable. Nothing was changed.");
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalledWith("[HEALTH_API_NETWORK] request failed", { path: "/v1/settings" }, expect.any(TypeError));
  });
});
