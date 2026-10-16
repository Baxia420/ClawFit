import { createHash } from "node:crypto";

export type HealthPluginConfig = {
  apiUrl?: string;
  allowedGroupIds?: string[];
};

export type SenderContext = {
  provider?: string;
  senderId?: string;
  conversationId?: string;
  mealFor?: string | undefined;
};

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
  sender?: SenderContext;
};

export class HealthApiNetworkError extends Error {
  override name = "HealthApiNetworkError";

  constructor() {
    super("ClawFit's health service is temporarily unavailable. Nothing was changed.");
  }
}

export class HealthApiResponseError extends Error {
  override name = "HealthApiResponseError";
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`${code}: ${message}`);
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
  const token = process.env.HEALTH_API_OPENCLAW_TOKEN;
  if (!token) throw new Error("HEALTH_API_OPENCLAW_TOKEN is not available to the OpenClaw Gateway");
  const apiUrl = config.apiUrl ?? process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
  const start = performance.now();
  let response: Response;
  // Fixed categories only: never log URLs, query strings, raw exceptions,
  // response bodies, sender identifiers, captions, or image payloads.
  const operation = path === "/v1/nutrition/estimate" ? "nutrition_estimate" : "health_request";
  const diagnostic = (reason: "success" | "http_error" | "network_error" | "invalid_response", status?: number) => {
    console.info(`[clawfit-api] ${JSON.stringify({ operation, reason, ...(status === undefined ? {} : { status }), durationMs: Math.round(performance.now() - start) })}`);
  };

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
  };
  if (options.sender?.senderId) {
    headers["x-clawfit-sender-provider"] = options.sender.provider ?? "whatsapp";
    headers["x-clawfit-sender-id"] = options.sender.senderId;
  }
  if (options.sender?.conversationId) {
    headers["x-clawfit-conversation-id"] = options.sender.conversationId;
  }
  if (options.sender?.mealFor) headers["x-clawfit-meal-for"] = options.sender.mealFor;
  const requestPath = options.sender?.mealFor && options.sender.mealFor !== "self" && /^\/v1\/(?:meals|nutrition\/(?:daily|trend))\b/.test(path)
    ? path.replace("/v1/", "/v1/household/") : path;

  try {
    // Cancellation must not replace the request deadline. Nutrition includes
    // bounded model recovery; allow upload/response overhead beyond its 60s budget.
    const timeout = AbortSignal.timeout(operation === "nutrition_estimate" ? 75_000 : 30_000);
    response = await (options.fetchImpl ?? fetch)(new URL(requestPath, apiUrl), {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    diagnostic("network_error");
    throw new HealthApiNetworkError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    diagnostic("invalid_response", response.status);
    throw new HealthApiNetworkError();
  }
  if (!response.ok) {
    diagnostic("http_error", response.status);
    const apiError = payload as { error?: { code?: string; message?: string } };
    throw new HealthApiResponseError(response.status, apiError.error?.code ?? "HEALTH_API_ERROR", apiError.error?.message ?? `Health API returned ${response.status}`);
  }
  const recipient = response.headers.get("x-clawfit-meal-recipient");
  if (recipient && payload && typeof payload === "object") {
    let profile: unknown;
    try {
      profile = JSON.parse(decodeURIComponent(recipient));
      const value = profile as { userId?: unknown; displayName?: unknown };
      if (typeof value.userId !== "string" || typeof value.displayName !== "string" || !value.displayName || value.displayName.length > 120) throw new Error("Invalid recipient response");
    } catch { diagnostic("invalid_response", response.status); throw new HealthApiNetworkError(); }
    diagnostic("success", response.status);
    return { ...(Array.isArray(payload) ? { meals: payload } : payload), recipient: profile } as T;
  }
  diagnostic("success", response.status);
  return payload as T;
}

function normalizeScopeSegment(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "openclaw";
}
