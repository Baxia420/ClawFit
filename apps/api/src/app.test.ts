import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { HealthRepository } from "@clawfit/db";

const token = "test-token-that-is-at-least-24-chars";
const repository = {
  listRecentMeals: vi.fn().mockResolvedValue([]),
  createMeal: vi.fn(),
} as unknown as HealthRepository;

describe("Health API", () => {
  it("allows the public health endpoint", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("requires bearer authentication", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "GET", url: "/v1/meals/recent" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("rejects invalid domain payloads", async () => {
    const app = createApp({ repository, apiToken: token, logger: false });
    const response = await app.inject({ method: "POST", url: "/v1/meals", headers: { authorization: `Bearer ${token}` }, payload: { label: "missing nutrition" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PAYLOAD");
    await app.close();
  });
});
