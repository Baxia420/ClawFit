import { describe, expect, it, vi } from "vitest";
import { readGoogleCredentials } from "@clawfit/health-core";
import { GeminiNutritionClient } from "./gemini-client.js";
import { nextPacificMidnight, quotaCooldown } from "./gemini-credential-pool.js";
import { configSchema } from "./config.js";

const credentials = readGoogleCredentials({ GEMINI_API_KEY: "fake-primary", GEMINI_API_KEY_1: "fake-backup-one", GEMINI_API_KEY_2: "fake-backup-two" });
const request = { model: "fake-model", prompt: "private meal", images: [{ mimeType: "image/png", base64: "private-image" }] };
const success = () => Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
const quota = (seconds = "60") => Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "private details" } }, { status: 429, headers: { "retry-after": seconds } });
function clock() {
  let now = Date.parse("2026-10-19T18:00:00Z");
  return { now: () => now, advance: (ms: number) => { now += ms; }, wait: vi.fn(async (ms: number) => { now += ms; }), random: () => 0 };
}
const key = (init?: RequestInit) => new Headers(init?.headers).get("x-goog-api-key");

describe("nutrition credential failover", () => {
  it("retries a quota failure on the same model with identical input, then stays on the healthy slot", async () => {
    const runtime = clock(), logs = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(quota()).mockImplementation(async () => success());
    const client = new GeminiNutritionClient(credentials, fetcher, logs, runtime);
    await expect(client.generate(request)).resolves.toEqual({ ok: true });
    await client.generate(request);
    expect(fetcher.mock.calls.map(([, init]) => key(init))).toEqual(["fake-primary", "fake-backup-one", "fake-backup-one"]);
    expect(new Set(fetcher.mock.calls.map(([url]) => url)).size).toBe(1);
    expect(new Set(fetcher.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
    expect(runtime.wait).not.toHaveBeenCalled();
    expect(logs.mock.calls[0]?.[0]).toMatchObject({ credentialId: "primary", quotaScope: "minute_or_unknown", cooldownUntil: runtime.now() + 60_000 });
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/fake-primary|fake-backup|private/);
  });
  it("caps each generation at two attempts and starts the next request on an eligible third slot", async () => {
    const runtime = clock();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(quota()).mockResolvedValueOnce(quota()).mockResolvedValueOnce(success());
    const client = new GeminiNutritionClient(credentials, fetcher, vi.fn(), runtime);
    await expect(client.generate(request)).rejects.toThrow("429");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.generate(request)).resolves.toEqual({ ok: true });
    expect(key(fetcher.mock.calls[2]?.[1])).toBe("fake-backup-two");
  });
  it("does not hammer an exhausted pool, and recovers once cooldowns expire", async () => {
    const runtime = clock();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => quota());
    const client = new GeminiNutritionClient(credentials.slice(0, 2), fetcher, vi.fn(), runtime);
    await expect(client.generate(request)).rejects.toThrow("429");
    await expect(client.generate(request)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
    runtime.advance(60_001);
    fetcher.mockImplementation(async () => success());
    await expect(client.generate(request)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("keeps rate-limit cooldowns model-specific", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(quota()).mockResolvedValueOnce(success());
    const client = new GeminiNutritionClient(credentials.slice(0, 1), fetcher, vi.fn(), clock());
    await expect(client.generate(request)).rejects.toThrow("429");
    await expect(client.generate({ ...request, model: "other-model" })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403, 404])("does not cycle the pool for HTTP %s", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, { status })).mockResolvedValueOnce(success());
    const client = new GeminiNutritionClient(credentials, fetcher, vi.fn(), clock());
    await expect(client.generate(request)).rejects.toThrow(`(${status})`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (status === 401) {
      await client.generate(request);
      expect(key(fetcher.mock.calls[1]?.[1])).toBe("fake-backup-one");
    }
  });
  it("does not rotate for malformed responses or provider safety blocks", async () => {
    for (const payload of [{ candidates: [{ content: { parts: [{ text: "private-invalid-json" }] } }] }, { promptFeedback: { blockReason: "SAFETY" } }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
      await expect(new GeminiNutritionClient(credentials, fetcher).generate(request)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("does not grant a fresh deadline after switching credentials", async () => {
    const runtime = clock();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { runtime.advance(21_500); return quota(); });
    await expect(new GeminiNutritionClient(credentials, fetcher, vi.fn(), runtime).generate(request)).rejects.toThrow("429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a concurrent success cannot erase another request's cooldown", async () => {
    const runtime = clock();
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(quota());
    const client = new GeminiNutritionClient(credentials.slice(0, 1), fetcher, vi.fn(), runtime);
    const first = client.generate(request);
    await expect(client.generate(request)).rejects.toThrow("429");
    finish(success()); await first;
    await expect(client.generate(request)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("uses structured daily quota metadata and the longest valid provider retry hint", () => {
  const now = Date.parse("2026-10-19T18:00:00Z");
  const body = { error: { message: "private", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" },
  ] } };
  expect(quotaCooldown(quota(), body, now)).toEqual({ until: Date.parse("2026-10-20T07:00:00Z"), scope: "daily" });
  expect(quotaCooldown(quota("bad-value"), { error: { details: [body.error.details[1]] } }, now).until).toBe(now + 90_000);
  expect(quotaCooldown(quota("120"), { error: { details: [body.error.details[1]] } }, now).until).toBe(now + 120_000);
  expect(quotaCooldown(quota("bad-value"), {}, now).until).toBe(now + 60_000);
});
it.each([
  ["2026-03-08T08:30:00Z", "2026-03-09T07:00:00Z"],
  ["2026-11-01T07:30:00Z", "2026-11-02T08:00:00Z"],
])("computes Pacific daily reset across daylight-saving transitions: %s", (now, expected) => {
  expect(new Date(nextPacificMidnight(Date.parse(now))).toISOString()).toBe(expected.replace("Z", ".000Z"));
});
it("retains backup credentials through API config parsing", () => {
  const config = configSchema.parse({ DATABASE_URL: "postgres://localhost/test", HEALTH_API_WEB_TOKEN: "web-token-at-least-24-characters", HEALTH_API_OPENCLAW_TOKEN: "gateway-token-at-least-24-characters", GEMINI_API_KEY: "fake-primary", GEMINI_API_KEY_2: "fake-backup" });
  expect(readGoogleCredentials(config).map(c => c.id)).toEqual(["primary", "backup-2"]);
});
