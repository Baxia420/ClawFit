// Observe only the existing preflight process; never change its request or result.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parse } from "dotenv";
import { z } from "zod";

const target = resolve(process.cwd(), "scripts/openclaw-preflight.ts");
if (process.argv[1] && resolve(process.argv[1]) === target) {
  const { fetchHealthReadiness, readinessDnsCode } = await import("./health-readiness-fetch.ts");
  const verifyDnsRetry = process.env.CLAWFIT_VERIFY_READINESS_DNS_RETRY === "1";
  // The verification overlay is for the old, single-attempt CIA gate. A checkout
  // that already has the repository retry must never acquire a second layer.
  let dnsRetryAlreadyInstalled = false;
  if (verifyDnsRetry) try {
    dnsRetryAlreadyInstalled = readFileSync(target, "utf8").includes("inspectHealthReadiness")
      && readFileSync(resolve(process.cwd(), "scripts/health-readiness.ts"), "utf8").includes("fetchHealthReadiness");
  } catch { /* The old checkout has no shared readiness helper. */ }
  const emit = fields => console.info(`[clawfit-preflight] ${JSON.stringify(fields)}`);
  const names = ["HEALTH_API_URL", "HEALTH_API_OPENCLAW_TOKEN"];
  const inherited = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let observed = false;
  function context() {
    let protectedValues;
    try { protectedValues = parse(readFileSync(resolve(process.env.OPENCLAW_STATE_DIR ?? resolve(homedir(), ".openclaw"), ".env"))); }
    catch { /* Only report source readability, never a path or exception. */ }
    const url = z.string().url().safeParse(process.env.HEALTH_API_URL);
    let originAccepted = false;
    if (url.success) {
      const base = new URL(url.data);
      originAccepted = !base.username && !base.password && (base.protocol === "https:" || ["localhost", "127.0.0.1"].includes(base.hostname));
    }
    return {
      runtime: process.versions.bun ? "bun" : process.release.name, nodeVersion: process.version,
      urlPresent: Boolean(process.env.HEALTH_API_URL), urlValid: url.success, originAccepted,
      tokenValid: z.string().min(24).safeParse(process.env.HEALTH_API_OPENCLAW_TOKEN).success,
      protectedEnvironmentReadable: protectedValues !== undefined,
      inherited: Object.fromEntries(names.map(name => [name, { present: inherited[name] !== undefined, matchesEffective: inherited[name] !== undefined && inherited[name] === process.env[name] }])),
      protectedEnvironment: Object.fromEntries(names.map(name => [name, { present: Boolean(protectedValues?.[name]), matchesEffective: protectedValues?.[name] !== undefined && protectedValues[name] === process.env[name] }])),
    };
  }
  const codes = {
    TimeoutError: "request_timeout", AbortError: "request_timeout", ETIMEDOUT: "request_timeout",
    UND_ERR_CONNECT_TIMEOUT: "request_timeout", UND_ERR_HEADERS_TIMEOUT: "request_timeout",
    ENOTFOUND: "dns_failure", EAI_AGAIN: "dns_failure", ECONNREFUSED: "connection_refused",
    ECONNRESET: "connection_reset", UND_ERR_SOCKET: "connection_reset",
    CERT_HAS_EXPIRED: "tls_failure", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
    DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure", ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
  };
  function reason(error, depth = 0) {
    if (!error || typeof error !== "object" || depth > 3) return "request_failed";
    for (const code of [error.code, error.name]) if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
    const cause = reason(error.cause, depth + 1);
    if (cause !== "request_failed") return cause;
    if (Array.isArray(error.errors)) for (const nested of error.errors.slice(0, 4)) {
      const result = reason(nested, depth + 1);
      if (result !== "request_failed") return result;
    }
    return "request_failed";
  }
  emit({ reason: "original_preflight_observer_attached", runtime: process.versions.bun ? "bun" : process.release.name, nodeVersion: process.version, verifyDnsRetry, dnsRetryAlreadyInstalled });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    let matches = false;
    try { matches = String(input instanceof Request ? input.url : input) === String(new URL("/ready", process.env.HEALTH_API_URL)); }
    catch { /* Invalid inputs are handled by the original gate. */ }
    if (!matches) return originalFetch.call(this, input, init);
    observed = true;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    emit({ reason: "original_readiness_request", ...context(), redirectPolicy: init?.redirect ?? "follow" });
    let response;
    try {
      response = verifyDnsRetry && !dnsRetryAlreadyInstalled
        ? await fetchHealthReadiness(new URL(String(input)), init, originalFetch.bind(this), report => emit(report))
        : await originalFetch.call(this, input, init);
    }
    catch (error) {
      const dnsCode = readinessDnsCode(error);
      emit({ reason: "original_readiness_transport_failure", failure: reason(error), ...(dnsCode ? { dnsCode } : {}), elapsedMs: elapsed() });
      throw error;
    }
    emit({ reason: "original_readiness_response", httpStatus: response.status, httpOk: response.ok, elapsedMs: elapsed() });
    const originalJson = response.json;
    response.json = async function(...args) {
      let body;
      try { body = await originalJson.apply(this, args); }
      catch (error) { emit({ reason: "original_readiness_body_failure", failure: reason(error) === "request_failed" ? "invalid_json" : reason(error), elapsedMs: elapsed() }); throw error; }
      emit({ reason: "original_readiness_contract", contractAccepted: z.object({ status: z.literal("ready"), estimator: z.literal("configured") }).safeParse(body).success,
        statusReady: body?.status === "ready", estimatorConfigured: body?.estimator === "configured", databaseOk: body?.database === "ok", schemaOk: body?.schema === "ok", elapsedMs: elapsed() });
      return body;
    };
    return response;
  };
  process.once("beforeExit", () => { if (!observed) emit({ reason: "original_readiness_request_not_observed", ...context() }); });
}
