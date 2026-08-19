import { createHash } from "node:crypto";

export type HealthPluginConfig = { apiUrl?: string };

type PendingScopeContext = {
  messageChannel?: string;
  requesterSenderId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type HealthFetchOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export class HealthApiNetworkError extends Error {
  override name = "HealthApiNetworkError";

  constructor() {
    super("ClawFit's health service is temporarily unavailable. Nothing was changed.");
  }
}

export function derivePendingMealScope(context: PendingScopeContext) {
  const channel = normalizeScopeSegment(context.messageChannel ?? "openclaw");
  const identity = context.requesterSenderId
    ? `peer:${context.requesterSenderId}`
    : context.sessionKey
      ? `session:${context.sessionKey}`
      : context.sessionId
        ? `session-id:${context.sessionId}`
        : "default";
  const digest = createHash("sha256").update(`${channel}:${identity}`).digest("hex").slice(0, 32);
  return `openclaw:${channel}:${digest}`;
}

export function withPendingMealScope(path: string, scopeKey: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}scopeKey=${encodeURIComponent(scopeKey)}`;
}

export async function healthFetch<T = unknown>(config: HealthPluginConfig, path: string, options: HealthFetchOptions = {}): Promise<T> {
  const token = process.env.HEALTH_API_TOKEN;
  if (!token) throw new Error("HEALTH_API_TOKEN is not available to the OpenClaw Gateway");
  const apiUrl = config.apiUrl ?? process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
  const start = performance.now();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(path, apiUrl), {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error("[HEALTH_API_NETWORK] request failed", { path }, error);
    throw new HealthApiNetworkError();
  }

  const durationMs = Math.round(performance.now() - start);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.error("[HEALTH_API_NETWORK] invalid response", { path, status: response.status }, error);
    throw new HealthApiNetworkError();
  }
  if (!response.ok) {
    const apiError = payload as { error?: { code?: string; message?: string } };
    throw new Error(`${apiError.error?.code ?? "HEALTH_API_ERROR"}: ${apiError.error?.message ?? `Health API returned ${response.status}`}`);
  }
  if (durationMs > 200) console.log(`[LATENCY] healthFetch path=${path} durationMs=${durationMs}`);
  return payload as T;
}

function normalizeScopeSegment(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "openclaw";
}
