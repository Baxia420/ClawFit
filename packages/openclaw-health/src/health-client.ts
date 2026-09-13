import { createHash } from "node:crypto";

export type HealthPluginConfig = {
  apiUrl?: string;
  allowedGroupIds?: string[];
};

export type SenderContext = {
  provider?: string;
  senderId?: string;
  conversationId?: string;
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
    super("ClawFit's health service is temporarily unavailable. Status could not be verified.");
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

  let requestSignal: AbortSignal;
  if (!options.signal) {
    requestSignal = AbortSignal.timeout(55_000);
  } else if (typeof AbortSignal.any === "function") {
    requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(55_000)]);
  } else {
    requestSignal = options.signal;
  }

  try {
    response = await (options.fetchImpl ?? fetch)(new URL(path, apiUrl), {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: requestSignal,
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

export type WhatsAppNutritionOperationIdOptions = {
  toolContext?: Record<string, unknown> | undefined;
  scopeKey: string;
  explicitOperationId?: string | undefined;
  text?: string | undefined;
  images?: Array<{ mimeType: string; base64: string }> | undefined;
};

export function deriveWhatsAppNutritionOperationId(options: WhatsAppNutritionOperationIdOptions): string {
  if (options.explicitOperationId && options.explicitOperationId.trim().length > 0) {
    return options.explicitOperationId.trim();
  }

  const rawCtx = options.toolContext as Record<string, unknown> | undefined;
  const deliveryCtx = rawCtx?.deliveryContext as Record<string, unknown> | undefined;

  const logicalId =
    (typeof rawCtx?.toolCallId === "string" && rawCtx.toolCallId ? rawCtx.toolCallId : undefined) ??
    (typeof rawCtx?.tool_call_id === "string" && rawCtx.tool_call_id ? rawCtx.tool_call_id : undefined) ??
    (typeof rawCtx?.messageId === "string" && rawCtx.messageId ? rawCtx.messageId : undefined) ??
    (typeof rawCtx?.id === "string" && rawCtx.id ? rawCtx.id : undefined) ??
    (typeof deliveryCtx?.messageId === "string" && deliveryCtx.messageId ? deliveryCtx.messageId : undefined) ??
    (typeof rawCtx?.incomingMessageId === "string" && rawCtx.incomingMessageId ? rawCtx.incomingMessageId : undefined) ??
    (typeof rawCtx?.callId === "string" && rawCtx.callId ? rawCtx.callId : undefined);

  if (logicalId) {
    return `wa_${options.scopeKey}_${logicalId}`;
  }

  const hasher = createHash("sha256");
  hasher.update(`wa:${options.scopeKey}:${options.text ?? ""}`);
  if (options.images && options.images.length > 0) {
    for (const img of options.images) {
      hasher.update(`:${img.mimeType}:${img.base64}`);
    }
  }
  const hashHex = hasher.digest("hex").slice(0, 16);
  return `wa_${options.scopeKey}_${hashHex}`;
}
