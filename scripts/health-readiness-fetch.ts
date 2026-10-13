import { setTimeout as delay } from "node:timers/promises";

export type DnsCode = "EAI_AGAIN" | "ENOTFOUND";
export function readinessDnsCode(error: unknown, depth = 0): DnsCode | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const value = error as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  if (value.name === "AbortError" || value.name === "TimeoutError") return undefined;
  if (value.code === "EAI_AGAIN" || value.code === "ENOTFOUND") return value.code;
  if (value.code !== undefined) return undefined;
  const cause = readinessDnsCode(value.cause, depth + 1);
  if (cause) return cause;
  if (Array.isArray(value.errors)) for (const nested of value.errors.slice(0, 4)) {
    const code = readinessDnsCode(nested, depth + 1);
    if (code) return code;
  }
  return undefined;
}

export type ReadinessAttempt = { reason: "readiness_dns_retry"; attempt: number; dnsCode: "EAI_AGAIN"; delayMs: number };

/** Only for the authenticated GET /ready. No HTTP/body/meal/model retries.
 * All attempts share the caller's original deadline and cancellation signal.
 */
export async function fetchHealthReadiness(
  input: URL,
  init: RequestInit,
  request: typeof fetch = fetch,
  onRetry: (attempt: ReadinessAttempt) => void = () => {},
): Promise<Response> {
  if (input.pathname !== "/ready" || (init.method ?? "GET") !== "GET" || !init.signal) throw new Error("Readiness retry requires GET /ready and a bounded signal");
  for (let attempt = 1; ; attempt++) {
    init.signal.throwIfAborted();
    try { return await request(input, init); }
    catch (error) {
      // Cancellation and permanent/unrecognized failures always retain the
      // original failure. Only a failed DNS lookup marked temporary is retried.
      if (init.signal.aborted || readinessDnsCode(error) !== "EAI_AGAIN" || attempt === 3) throw error;
      const delayMs = attempt * 250;
      onRetry({ reason: "readiness_dns_retry", attempt, dnsCode: "EAI_AGAIN", delayMs });
      await delay(delayMs, undefined, { signal: init.signal });
    }
  }
}
