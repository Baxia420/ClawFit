import { z } from "zod";

export type ReadinessReason = "ready" | "missing_api_url" | "invalid_api_url" | "unsafe_api_origin"
  | "invalid_api_token" | "request_timeout" | "dns_failure" | "connection_refused"
  | "connection_reset" | "tls_failure" | "request_failed" | "redirect_response"
  | "http_unauthorized" | "http_forbidden" | "http_unavailable" | "http_error"
  | "invalid_json" | "invalid_readiness_response" | "api_not_ready" | "estimator_unconfigured";
export type ReadinessReport = {
  reason: ReadinessReason;
  elapsedMs: number;
  httpStatus?: number;
  databaseOk?: boolean;
  schemaOk?: boolean;
};

const transportReasons: Record<string, ReadinessReason> = {
  TimeoutError: "request_timeout", AbortError: "request_timeout", ETIMEDOUT: "request_timeout",
  UND_ERR_CONNECT_TIMEOUT: "request_timeout", UND_ERR_HEADERS_TIMEOUT: "request_timeout",
  ENOTFOUND: "dns_failure", EAI_AGAIN: "dns_failure", ECONNREFUSED: "connection_refused",
  ECONNRESET: "connection_reset", UND_ERR_SOCKET: "connection_reset",
  CERT_HAS_EXPIRED: "tls_failure", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure", ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
};

function transportReason(error: unknown, depth = 0): ReadinessReason {
  if (!error || typeof error !== "object" || depth > 3) return "request_failed";
  const value = error as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  // Never serialize an Error, its message, stack, URL or arbitrary code.
  for (const code of [value.code, value.name]) {
    const reason = typeof code === "string" && Object.hasOwn(transportReasons, code) ? transportReasons[code] : undefined;
    if (reason) return reason;
  }
  const cause = transportReason(value.cause, depth + 1);
  if (cause !== "request_failed") return cause;
  if (Array.isArray(value.errors)) for (const nested of value.errors.slice(0, 4)) {
    const reason = transportReason(nested, depth + 1);
    if (reason !== "request_failed") return reason;
  }
  return "request_failed";
}

/** The same authenticated readiness gate as deployment, with bounded safe output.
 * No estimator request, retries, model selection, database write or secret output.
 */
export async function inspectHealthReadiness(
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
  timeoutMs = 50_000,
): Promise<ReadinessReport> {
  const started = performance.now();
  const report = (reason: ReadinessReason, fields: Omit<ReadinessReport, "reason" | "elapsedMs"> = {}): ReadinessReport =>
    ({ reason, elapsedMs: Math.round(performance.now() - started), ...fields });
  if (!env.HEALTH_API_URL) return report("missing_api_url");
  const validUrl = z.string().url().safeParse(env.HEALTH_API_URL);
  if (!validUrl.success) return report("invalid_api_url");
  const base = new URL(validUrl.data);
  if (base.username || base.password || (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))) return report("unsafe_api_origin");
  const token = z.string().min(24).safeParse(env.HEALTH_API_OPENCLAW_TOKEN);
  if (!token.success || /[\r\n]/.test(token.data)) return report("invalid_api_token");
  let response: Response;
  try {
    response = await request(new URL("/ready", base), {
      headers: { authorization: `Bearer ${token.data}` },
      // Observe redirects without forwarding credentials to another origin.
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) { return report(transportReason(error)); }
  const httpStatus = response.status;
  if (!response.ok) {
    // Error bodies can contain proxy HTML, credentials or personal information.
    await response.body?.cancel().catch(() => {});
    const reason = httpStatus >= 300 && httpStatus < 400 ? "redirect_response"
      : httpStatus === 401 ? "http_unauthorized" : httpStatus === 403 ? "http_forbidden"
        : httpStatus >= 500 ? "http_unavailable" : "http_error";
    return report(reason, { httpStatus });
  }
  let body: unknown;
  try { body = await response.json(); }
  catch (error) { return report(transportReason(error) === "request_failed" ? "invalid_json" : transportReason(error), { httpStatus }); }
  const parsed = z.object({ status: z.enum(["ready", "not_ready"]), estimator: z.enum(["configured", "unconfigured"]).optional(), database: z.unknown().optional(), schema: z.unknown().optional() }).safeParse(body);
  if (!parsed.success) return report("invalid_readiness_response", { httpStatus });
  const fields = { httpStatus, databaseOk: parsed.data.database === "ok", schemaOk: parsed.data.schema === "ok" };
  if (parsed.data.status !== "ready") return report("api_not_ready", fields);
  if (parsed.data.estimator === "unconfigured") return report("estimator_unconfigured", fields);
  if (parsed.data.estimator !== "configured") return report("invalid_readiness_response", fields);
  return report("ready", fields);
}
