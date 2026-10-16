import { expect, it, vi } from "vitest";
import { NutritionEstimator } from "@clawfit/health-core";
import { GeminiNutritionClient } from "./gemini-client.js";

// Use controllable timers for the native signal, while the fake transport
// observes cancellation just as fetch does. No provider traffic is made.
function fakeTimeouts() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Expired", "TimeoutError")), ms);
    return controller.signal;
  });
}

const output = { label: "Lunch", items: [], calories: { best: 300, low: 250, high: 350 }, macros: { protein_g: 10, carbs_g: 40, fat_g: 10, fiber_g: null }, confidence: "medium", uncertainty_reasons: ["Packet weight unknown"] };
const success = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 } });
function clock() {
  let now = 1000;
  return { now: () => now, wait: vi.fn(async (ms: number) => { now += ms; }), random: () => 0 };
}

it("recovers once from a transient provider failure with identical input and safe diagnostics", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { status: "UNAVAILABLE", message: "private photo and API key" } }, { status: 503 })).mockResolvedValueOnce(success());
  const log = vi.fn(), runtime = clock();
  const client = new GeminiNutritionClient("secret-key", fetchImpl, log, runtime);
  const result = await client.generate({ model: "test-model", prompt: "private meal", image: { mimeType: "image/jpeg", base64: "private-image" } });
  expect(result).toEqual(output);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0]![1]!.body).toEqual(fetchImpl.mock.calls[1]![1]!.body);
  expect(runtime.wait).toHaveBeenCalledWith(500);
  expect(log.mock.calls.map(([entry]) => entry)).toEqual([
    expect.objectContaining({ attempt: 1, status: 503, reason: "http_error", providerCode: "UNAVAILABLE" }),
    expect.objectContaining({ attempt: 2, reason: "success", inputTokens: 100, outputTokens: 50, thinkingTokens: 25, totalTokens: 175 }),
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret-key/);
});

it.each([400, 401, 403, 404])("does not retry HTTP %s", async status => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "private" } }, { status }));
  await expect(new GeminiNutritionClient("secret", fetchImpl, vi.fn(), clock()).generate({ model: "test", prompt: "meal" })).rejects.toThrow(`(${status})`);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("respects long quota cooldowns and stops after two transient attempts", async () => {
  const quota = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429, headers: { "retry-after": "60" } }));
  const runtime = clock();
  await expect(new GeminiNutritionClient("secret", quota, vi.fn(), runtime).generate({ model: "test", prompt: "meal" })).rejects.toThrow("429");
  expect(quota).toHaveBeenCalledTimes(1);
  expect(runtime.wait).not.toHaveBeenCalled();
  const unavailable = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}, { status: 503 }));
  await expect(new GeminiNutritionClient("secret", unavailable, vi.fn(), clock()).generate({ model: "test", prompt: "meal" })).rejects.toThrow("503");
  expect(unavailable).toHaveBeenCalledTimes(2);
});

it("shares a deadline across models and does not start another request after expiry", async () => {
  const runtime = clock();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => { await runtime.wait(22_000); return Response.json({}, { status: 503 }); });
  const client = new GeminiNutritionClient("secret", fetchImpl, vi.fn(), runtime);
  await expect(client.generate({ model: "test", prompt: "meal", deadline: 23_000 })).rejects.toThrow("503");
  await expect(client.generate({ model: "fallback", prompt: "meal", deadline: 23_000 })).rejects.toThrow("timed out");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("recovers from network failure but never retries malformed JSON or leaks it", async () => {
  const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("private network detail")).mockResolvedValueOnce(success());
  await expect(new GeminiNutritionClient("secret", network, vi.fn(), clock()).generate({ model: "test", prompt: "meal" })).resolves.toEqual(output);
  const invalid = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "PRIVATE OUTPUT" }] } }] }));
  await expect(new GeminiNutritionClient("secret", invalid).generate({ model: "test", prompt: "meal" })).rejects.toThrow("invalid JSON");
  expect(invalid).toHaveBeenCalledTimes(1);
});

it("runs retries inside estimation without involving any write endpoint", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(success());
  const result = await new NutritionEstimator(new GeminiNutritionClient("secret", fetchImpl, vi.fn(), clock()), ["primary"]).estimate({ text: "lunch" });
  expect(result.estimate.calories.best).toBe(300);
  expect(fetchImpl.mock.calls.every(([url, init]) => String(url).endsWith(":generateContent") && init?.method === "POST")).toBe(true);
});

it.each([false, true])("allows a 20-second generation, after transient error=%s", async retry => {
  fakeTimeouts();
  try {
    let calls = 0;
    const transport: typeof fetch = async (_url, init) => {
      if (retry && calls++ === 0) return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(success()), 20_000);
        init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
      });
    };
    const result = new GeminiNutritionClient("secret", transport).generate({ model: "test", prompt: "meal" });
    const assertion = expect(result).resolves.toEqual(output);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

it("aborts a hung request at the shared deadline and reports timeouts while reading the body", async () => {
  fakeTimeouts();
  try {
    const log = vi.fn();
    const transport: typeof fetch = async (_url, init) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) }) as Response;
    const result = new GeminiNutritionClient("secret", transport, log).generate({ model: "test", prompt: "meal", deadline: Date.now() + 5_000 });
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout", durationMs: 5_000 }));
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "success" }));
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});
