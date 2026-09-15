import { describe, expect, it, vi } from "vitest";
import { NutritionEstimator } from "@clawfit/health-core";
import {
  GeminiNutritionClient,
  InvalidImagePayloadError,
  UpstreamRateLimitError,
  UpstreamTimeoutError,
} from "./gemini-client.js";

const sampleValidJson = JSON.stringify({
  label: "Grilled Chicken Breast with Rice",
  items: [
    { name: "Grilled Chicken", portion_description: "150g", calories: 240, protein_g: 45, carbs_g: 0, fat_g: 5, fiber_g: 0 },
    { name: "White Rice", portion_description: "1 cup", calories: 200, protein_g: 4, carbs_g: 45, fat_g: 0.5, fiber_g: 1 },
  ],
  calories: { best: 440, low: 400, high: 480 },
  macros: { protein_g: 49, carbs_g: 45, fat_g: 5.5, fiber_g: 1 },
  confidence: "high",
  uncertainty_reasons: [],
});

describe("GeminiNutritionClient", () => {
  it("serializes multimodal images into inlineData parts along with prompt text", async () => {
    let capturedBody: any = null;
    const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: sampleValidJson }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    const result = (await client.generate({
      model: "gemini-3.8-flash",
      prompt: "Estimate this food",
      images: [
        { mimeType: "image/jpeg", base64: "base64data1" },
        { mimeType: "image/png", base64: "base64data2" },
      ],
    })) as { data: any };

    expect(result.data.label).toBe("Grilled Chicken Breast with Rice");
    expect(capturedBody.contents[0].parts).toHaveLength(3);
    expect(capturedBody.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "base64data1" },
    });
    expect(capturedBody.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: "image/png", data: "base64data2" },
    });
    expect(capturedBody.contents[0].parts[2]).toEqual({
      text: "Estimate this food",
    });
  });

  it("handles text-only requests gracefully without image parts", async () => {
    let capturedBody: any = null;
    const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: sampleValidJson }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    await client.generate({
      model: "gemini-3.8-flash",
      prompt: "2 eggs and toast",
    });

    expect(capturedBody.contents[0].parts).toHaveLength(1);
    expect(capturedBody.contents[0].parts[0]).toEqual({ text: "2 eggs and toast" });
  });

  it("throws typed UpstreamRateLimitError on HTTP 429 / RESOURCE_EXHAUSTED", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    await expect(client.generate({ model: "gemini-3.8-flash", prompt: "chicken rice" })).rejects.toThrow(
      UpstreamRateLimitError,
    );
  });

  it("throws typed InvalidImagePayloadError on HTTP 400 / INVALID_ARGUMENT", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 400, message: "Invalid image bytes", status: "INVALID_ARGUMENT" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    await expect(client.generate({ model: "gemini-3.8-flash", prompt: "invalid image" })).rejects.toThrow(
      InvalidImagePayloadError,
    );
  });

  it("throws typed UpstreamTimeoutError on HTTP 503 / 504 / UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 503, message: "Service Unavailable", status: "UNAVAILABLE" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    await expect(client.generate({ model: "gemini-3.8-flash", prompt: "dinner" })).rejects.toThrow(
      UpstreamTimeoutError,
    );
  });

  it("simulates a timeout on gemini-3.8-flash and cleanly falls back to gemini-3.7-flash", async () => {
    const attemptedModels: string[] = [];

    const fetchImpl = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("gemini-3.8-flash")) {
        attemptedModels.push("gemini-3.8-flash");
        // Simulate aborting / timing out on primary model
        const abortErr = new Error("The operation was aborted due to timeout");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (urlStr.includes("gemini-3.7-flash")) {
        attemptedModels.push("gemini-3.7-flash");
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: sampleValidJson }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected model URL: ${urlStr}`);
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    const estimator = new NutritionEstimator(client, ["gemini-3.8-flash", "gemini-3.7-flash"]);

    const result = await estimator.estimate({
      text: "Chicken breast with rice",
      image: { mimeType: "image/jpeg", base64: "dGVzdA==" },
    });

    expect(attemptedModels).toEqual(["gemini-3.8-flash", "gemini-3.7-flash"]);
    expect(result.fallbackUsed).toBe(true);
    expect(result.model).toBe("gemini-3.7-flash");
    expect(result.estimate.label).toBe("Grilled Chicken Breast with Rice");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.model).toBe("gemini-3.8-flash");
    expect(result.attempts[0]?.code).toBe("TIMEOUT_OR_CANCELLED");
  });

  it("falls back through all 3 tiers (3.8 -> 3.7 -> 3.5-flash-lite) when quota is exhausted", async () => {
    const attemptedModels: string[] = [];

    const fetchImpl = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("gemini-3.8-flash")) {
        attemptedModels.push("gemini-3.8-flash");
        return new Response(
          JSON.stringify({
            error: { code: 429, message: "Resource has been exhausted.", status: "RESOURCE_EXHAUSTED" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("gemini-3.7-flash")) {
        attemptedModels.push("gemini-3.7-flash");
        return new Response(
          JSON.stringify({
            error: { code: 429, message: "Resource has been exhausted.", status: "RESOURCE_EXHAUSTED" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("gemini-3.5-flash-lite")) {
        attemptedModels.push("gemini-3.5-flash-lite");
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: sampleValidJson }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected model URL: ${urlStr}`);
    });

    const client = new GeminiNutritionClient("fake-key", fetchImpl as any);
    const estimator = new NutritionEstimator(client, [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.5-flash-lite",
    ]);

    const result = await estimator.estimate({
      text: "2 eggs and coffee",
    });

    expect(attemptedModels).toEqual(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"]);
    expect(result.fallbackUsed).toBe(true);
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(result.estimate.label).toBe("Grilled Chicken Breast with Rice");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.model).toBe("gemini-3.8-flash");
    expect(result.attempts[1]?.model).toBe("gemini-3.7-flash");
  });
});

