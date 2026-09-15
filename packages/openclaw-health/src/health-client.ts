import { createHash } from "node:crypto";
import { DEFAULT_PRIMARY_USER_ID, DEFAULT_PARTNER_USER_ID } from "@clawfit/health-core";

export type HealthPluginConfig = {
  apiUrl?: string;
  allowedGroupIds?: string[];
};

export type SenderContext = {
  provider?: string;
  senderId?: string;
  conversationId?: string;
  targetUserId?: string;
};

type PendingScopeContext = {
  messageChannel?: string;
  requesterSenderId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type HealthFetchOptions = {
  method?: string | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  sender?: SenderContext | undefined;
};

export class HealthApiNetworkError extends Error {
  override name = "HealthApiNetworkError";

  constructor() {
    super("ClawFit's health service is temporarily unavailable. Status could not be verified.");
  }
}

export class HealthApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "HealthApiError";
    this.code = code;
  }
}

export type NutritionEstimateInput = {
  operationId?: string | undefined;
  text?: string | undefined;
  image?: { mimeType: string; base64: string } | undefined;
  images?: Array<{ mimeType: string; base64?: string; data?: string }> | undefined;
  targetUserId?: string | undefined;
  targetUserName?: string | undefined;
};

export function derivePendingMealScope(context: PendingScopeContext, targetUserId?: string) {
  const channel = normalizeScopeSegment(context.messageChannel ?? "openclaw");
  const identity = context.requesterSenderId
    ? `peer:${context.requesterSenderId}`
    : context.sessionKey
      ? `session:${context.sessionKey}`
      : context.sessionId
        ? `session-id:${context.sessionId}`
        : "default";
  const targetSegment = targetUserId ? `:target:${targetUserId}` : "";
  const digest = createHash("sha256").update(`${channel}:${identity}${targetSegment}`).digest("hex").slice(0, 32);
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
  const explicitTarget = (options as { targetUserId?: string }).targetUserId ?? options.sender?.targetUserId;
  if (explicitTarget) {
    headers["x-clawfit-target-user-id"] = explicitTarget;
  } else if (options.sender?.senderId?.includes("142419432")) {
    headers["x-clawfit-target-user-id"] = DEFAULT_PARTNER_USER_ID;
  } else if (options.sender?.senderId?.includes("143224693")) {
    headers["x-clawfit-target-user-id"] = DEFAULT_PRIMARY_USER_ID;
  }

  let requestSignal: AbortSignal;
  if (!options.signal) {
    requestSignal = AbortSignal.timeout(60_000);
  } else if (typeof AbortSignal.any === "function") {
    requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
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
    const code = apiError.error?.code ?? "HEALTH_API_ERROR";
    const message = apiError.error?.message ?? `Health API returned ${response.status}`;
    throw new HealthApiError(code, message);
  }
  if (durationMs > 200) console.log(`[LATENCY] healthFetch path=${path} durationMs=${durationMs}`);
  return payload as T;
}

export async function estimateNutrition<T = unknown>(
  config: HealthPluginConfig,
  input: NutritionEstimateInput,
  options: { sender?: SenderContext | undefined; signal?: AbortSignal | undefined; fetchImpl?: typeof fetch | undefined } = {},
): Promise<T> {
  const images = input.images && input.images.length > 0
    ? input.images.map((img) => ({
        mimeType: img.mimeType,
        base64: img.base64 ?? img.data ?? "",
      }))
    : input.image
      ? [{ mimeType: input.image.mimeType, base64: input.image.base64 }]
      : undefined;

  const firstImage = images && images.length === 1 ? images[0] : input.image;
  const body: Record<string, unknown> = {
    text: input.text ?? "",
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
    ...(firstImage ? { image: firstImage } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  };

  return healthFetch<T>(config, "/v1/nutrition/estimate", {
    method: "POST",
    body,
    ...(options.sender !== undefined ? { sender: options.sender } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
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
