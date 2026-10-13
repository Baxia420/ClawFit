import { expect, it, vi } from "vitest";
import { inspectHealthReadiness } from "./health-readiness.js";

const env = { HEALTH_API_URL: "https://private-api.example.test", HEALTH_API_OPENCLAW_TOKEN: "private-token-at-least-24-characters" };
const ready = { status: "ready", estimator: "configured", database: "ok", schema: "ok" };

it("performs only the original authenticated readiness gate with a bounded timeout", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ready));
  expect(await inspectHealthReadiness(env, request)).toMatchObject({ reason: "ready", httpStatus: 200, databaseOk: true, schemaOk: true });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0]!;
  expect(String(url)).toBe("https://private-api.example.test/ready");
  expect(init).toMatchObject({ headers: { authorization: `Bearer ${env.HEALTH_API_OPENCLAW_TOKEN}` }, redirect: "manual" });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

it.each([
  [{ ...env, HEALTH_API_URL: undefined }, "missing_api_url"],
  [{ ...env, HEALTH_API_URL: "not a URL with private message" }, "invalid_api_url"],
  [{ ...env, HEALTH_API_URL: "http://private-api.example.test" }, "unsafe_api_origin"],
  [{ ...env, HEALTH_API_URL: "https://secret:credential@private-api.example.test" }, "unsafe_api_origin"],
  [{ ...env, HEALTH_API_OPENCLAW_TOKEN: "short" }, "invalid_api_token"],
  [{ ...env, HEALTH_API_OPENCLAW_TOKEN: `${env.HEALTH_API_OPENCLAW_TOKEN}\r\nsecret` }, "invalid_api_token"],
])("reports input failures without making a request or exposing values: %s", async (input, reason) => {
  const request = vi.fn<typeof fetch>();
  const result = await inspectHealthReadiness(input, request);
  expect(result.reason).toBe(reason);
  expect(request).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/private|credential|secret|short|message/);
});

it.each([
  [new DOMException("Secret token in timeout message", "TimeoutError"), "request_timeout"],
  [{ cause: { code: "ENOTFOUND", message: env.HEALTH_API_URL } }, "dns_failure"],
  [{ cause: { code: "ECONNREFUSED" } }, "connection_refused"],
  [{ cause: { code: "ECONNRESET" } }, "connection_reset"],
  [{ cause: { errors: [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }] } }, "tls_failure"],
  [{ cause: { errors: [{ code: "UNKNOWN_PRIVATE_CODE" }] }, message: "private phone and token" }, "request_failed"],
  [{ code: "__proto__" }, "request_failed"],
])("classifies transport failures without leaking an Error: %s", async (error, reason) => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(error);
  const result = await inspectHealthReadiness(env, request);
  expect(result.reason).toBe(reason);
  expect(JSON.stringify(result)).not.toMatch(/private|Secret|token|phone|UNKNOWN|https/);
});

it.each([
  [302, "redirect_response"], [401, "http_unauthorized"], [403, "http_forbidden"],
  [404, "http_error"], [503, "http_unavailable"],
])("rejects HTTP %s without reading or logging its body", async (httpStatus, reason) => {
  const response = new Response("Private credential and image bytes", { status: httpStatus, headers: { location: "https://untrusted.example.test" } });
  const read = vi.spyOn(response, "json");
  const request = vi.fn<typeof fetch>().mockResolvedValue(response);
  expect(await inspectHealthReadiness(env, request)).toMatchObject({ reason, httpStatus });
  expect(read).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  [{ status: "ready", estimator: "unconfigured" }, "estimator_unconfigured"],
  [{ status: "not_ready" }, "api_not_ready"],
  [{ status: "ready" }, "invalid_readiness_response"],
  [{ status: "private error body", estimator: "configured" }, "invalid_readiness_response"],
])("rejects incomplete or unready JSON responses: %s", async (body, reason) => {
  const result = await inspectHealthReadiness(env, vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)));
  expect(result.reason).toBe(reason);
  expect(JSON.stringify(result)).not.toContain("private");
});

it("distinguishes invalid JSON from a timeout while receiving the body", async () => {
  expect((await inspectHealthReadiness(env, vi.fn<typeof fetch>().mockResolvedValue(new Response("private proxy HTML")))).reason).toBe("invalid_json");
  const response = Response.json(ready);
  vi.spyOn(response, "json").mockRejectedValue(new DOMException("private timeout detail", "AbortError"));
  expect((await inspectHealthReadiness(env, vi.fn<typeof fetch>().mockResolvedValue(response))).reason).toBe("request_timeout");
});

it("retains the existing success schema without requiring extra fields or probing Gemini", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "ready", estimator: "configured" }));
  expect((await inspectHealthReadiness(env, request)).reason).toBe("ready");
  expect(request).toHaveBeenCalledTimes(1);
});
