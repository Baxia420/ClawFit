import { afterEach, expect, it, vi } from "vitest";
import { fetchHealthReadiness, readinessDnsCode } from "./health-readiness-fetch.js";
import { inspectHealthReadiness } from "./health-readiness.js";

const url = new URL("https://private-api.example.test/ready");
const env = { HEALTH_API_URL: url.origin, HEALTH_API_OPENCLAW_TOKEN: "private-token-at-least-24-characters" };
const ready = { status: "ready", estimator: "configured" };
const temporary = { cause: { code: "EAI_AGAIN", message: "private hostname and token" } };
afterEach(() => vi.useRealTimers());

it("recovers a temporary DNS failure, using the same URL, authorization, redirect policy and signal", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(temporary).mockResolvedValue(Response.json(ready));
  const report = await inspectHealthReadiness(env, request);
  expect(report).toMatchObject({ reason: "ready", attempts: 2 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${env.HEALTH_API_OPENCLAW_TOKEN}` }, redirect: "manual" });
  expect(JSON.stringify(report)).not.toMatch(/private|token|hostname|https/);
});

it("exhausts at three temporary DNS failures and keeps the gate failed with a safe code", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(temporary);
  expect(await inspectHealthReadiness(env, request)).toMatchObject({ reason: "dns_failure", dnsCode: "EAI_AGAIN", attempts: 3 });
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["ENOTFOUND", "ECONNRESET", "ERR_TLS_CERT_ALTNAME_INVALID", "UNKNOWN_PRIVATE_CODE"])("does not retry %s", async code => {
  const request = vi.fn<typeof fetch>().mockRejectedValue({ cause: { code, message: "private error" } });
  const report = await inspectHealthReadiness(env, request);
  expect(report.reason).not.toBe("ready");
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report)).not.toMatch(/UNKNOWN|private|message/);
  if (code === "ENOTFOUND") expect(report.dnsCode).toBe("ENOTFOUND");
});

it.each([401, 403, 302, 503])("does not retry HTTP %s even after a temporary DNS failure", async status => {
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(temporary).mockResolvedValue(new Response("private body", { status }));
  expect((await inspectHealthReadiness(env, request)).reason).not.toBe("ready");
  expect(request).toHaveBeenCalledTimes(2);
});

it("does not retry invalid JSON or an unconfigured estimator", async () => {
  for (const response of [new Response("private invalid JSON"), Response.json({ status: "ready", estimator: "unconfigured" })]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect((await inspectHealthReadiness(env, request)).reason).not.toBe("ready");
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it("uses one total timeout for lookup attempts and retry delays, without resetting it", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(temporary);
  const result = await inspectHealthReadiness(env, request, 30);
  expect(result).toMatchObject({ reason: "request_timeout", attempts: 1 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("honors cancellation while waiting and never starts another request", async () => {
  const controller = new AbortController();
  const request = vi.fn<typeof fetch>().mockRejectedValue(temporary);
  const onRetry = vi.fn(() => controller.abort());
  await expect(fetchHealthReadiness(url, { signal: controller.signal }, request, onRetry)).rejects.toHaveProperty("name", "AbortError");
  expect(request).toHaveBeenCalledTimes(1);
  expect(onRetry).toHaveBeenCalledWith({ reason: "readiness_dns_retry", attempt: 1, dnsCode: "EAI_AGAIN", delayMs: 250 });
});

it.each([
  { name: "TimeoutError", cause: { code: "EAI_AGAIN" } },
  { name: "AbortError", cause: { code: "EAI_AGAIN" } },
  { code: "ECONNRESET", cause: { code: "EAI_AGAIN" } },
])("does not turn another failure with a nested DNS code into a retry: %s", async error => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(error);
  expect((await inspectHealthReadiness(env, request)).reason).not.toBe("ready");
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  ["/v1/nutrition/estimate", "POST"], ["/v1/meals/pending", "POST"], ["/v1/meals/confirm", "POST"], ["/ready", "POST"],
])("cannot retry non-readiness operations at %s", async (pathname, method) => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(temporary);
  await expect(fetchHealthReadiness(new URL(pathname, url), { method, signal: AbortSignal.timeout(1000) }, request)).rejects.toThrow("Readiness retry requires");
  expect(request).not.toHaveBeenCalled();
});

it("requires a caller deadline before issuing any request", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(fetchHealthReadiness(url, {}, request)).rejects.toThrow("Readiness retry requires");
  expect(request).not.toHaveBeenCalled();
});

it("keeps DNS classification bounded and ignores arbitrary codes/messages and cyclic errors", () => {
  expect(readinessDnsCode({ cause: { errors: [{ code: "EAI_AGAIN" }] } })).toBe("EAI_AGAIN");
  expect(readinessDnsCode({ code: "__proto__", message: "private", cause: { code: "UNKNOWN" } })).toBeUndefined();
  const error: { cause?: unknown } = {};
  error.cause = error;
  expect(readinessDnsCode(error)).toBeUndefined();
});
