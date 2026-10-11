import type { OpenClawPluginApi, OpenClawPluginToolContext, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/plugin-runtime";
import { isMealLogConfirmation, isNoSaveRequest, isFallbackNotice, TEMPORARY_FAILURE } from "./confirmation.js";
import type { MediaAuthorizationContext } from "./media-resolver.js";

export { TEMPORARY_FAILURE } from "./confirmation.js";
export const MEDIA_FAILURE = "I couldn't access that photo safely. Please resend it in this chat; I won't retry this image in this turn.";
const MEAL_WRITES = new Set(["create_pending_meal", "update_pending_meal", "log_meal", "confirm_pending_meal", "update_meal", "delete_meal", "delete_pending_meal", "save_food_preset", "update_food_preset", "delete_food_preset"]);

export interface InboundTurn {
  sessionKey: string;
  senderId: string;
  conversationId: string;
  accountId: string | undefined;
  messageId: string;
  text: string;
  paths: string[];
  hasImageAttachment: boolean;
  receivedAt: number;
  runId?: string;
  failedTools: Set<string>;
  failure?: { error: string; message: string; retryable: false };
  delivered: boolean;
  fallbackSent: boolean;
  dispatcher: PluginHookReplyDispatchContext["dispatcher"];
  canDeliver: boolean;
}

// Per-plugin-instance, ephemeral metadata only. Never infer ownership from the prompt,
// model parameters, session history, or a directory's contents.
export class InboundTurns {
  private turns: InboundTurn[] = [];
  private runs = new Map<string, InboundTurn>();
  private calls = new Map<string, InboundTurn>();

  constructor(api: OpenClawPluginApi) {
    api.on("reply_dispatch", (event, context) => {
      this.prune();
      const msg = event.ctx;
      const provider = msg.OriginatingChannel ?? msg.Provider ?? msg.Surface;
      const sessionKey = event.sessionKey ?? msg.SessionKey;
      const senderId = msg.SenderId;
      const conversationId = msg.OriginatingTo ?? msg.To;
      const messageId = msg.MessageSidFull ?? msg.MessageSid;
      if (provider !== "whatsapp" || !sessionKey || !senderId || !conversationId || !messageId) return;
      // Tail dispatch is the same inbound message, not a new authorization grant.
      if (this.turns.some(t => t.sessionKey === sessionKey && t.messageId === messageId
        && t.senderId === senderId && t.conversationId === conversationId && t.accountId === msg.AccountId)) return;
      const paths = [...new Set(msg.MediaPaths?.length ? msg.MediaPaths : msg.MediaPath ? [msg.MediaPath] : [])];
      const turn: InboundTurn = {
        sessionKey, senderId, conversationId, messageId,
        accountId: msg.AccountId,
        text: msg.BodyForCommands ?? msg.RawBody ?? "",
        paths,
        hasImageAttachment: paths.length > 0 || Boolean(event.images?.length)
          || Boolean(msg.MediaType?.startsWith("image/"))
          || Boolean(msg.MediaTypes?.some(type => type.startsWith("image/")))
          || Boolean(msg.MediaUrl || msg.MediaUrls?.length),
        failedTools: new Set(), receivedAt: Date.now(), delivered: false, fallbackSent: false,
        dispatcher: context.dispatcher,
        canDeliver: event.sendPolicy === "allow" && !event.suppressUserDelivery && !event.shouldRouteToOriginating,
      };
      this.turns.push(turn);
      if (event.runId) this.bind(event.runId, turn);
    });
    api.on("before_prompt_build", (_event, context) => {
      this.prune();
      if (!context.runId || this.runs.has(context.runId)) return; // retain across model failover
      const candidates = this.turns.filter(t => !t.runId && t.sessionKey === context.sessionKey
        && t.senderId === context.senderId && t.conversationId === (context.chatId ?? context.channelId));
      if (candidates.length === 1 && candidates[0]) this.bind(context.runId, candidates[0]);
    }, { priority: 200 });
    api.on("before_tool_call", (event, context) => {
      const runId = context.runId ?? event.runId;
      const turn = runId ? this.runs.get(runId) : undefined;
      if (turn && event.toolCallId && context.sessionKey === turn.sessionKey) {
        this.calls.set(this.callKey(turn.sessionKey, event.toolCallId), turn);
      }
      if (turn?.failure && (turn.failedTools.has(event.toolName) || MEAL_WRITES.has(event.toolName))) {
        return { block: true, blockReason: `${turn.failure.message} Do not retry or save a meal in this turn.` };
      }
      if (!MEAL_WRITES.has(event.toolName)) return;
      if (!turn) return { block: true, blockReason: "Missing trusted current-message context. Do not save a draft or meal; ask the user to resend their request." };
      if (isNoSaveRequest(turn.text)) {
        return { block: true, blockReason: "The user explicitly requested no saving. Do not create or modify a pending draft or logged meal." };
      }
      if ((event.toolName === "log_meal" || event.toolName === "confirm_pending_meal") && !isMealLogConfirmation(turn.text)) {
        return { block: true, blockReason: "No confirmation in the current trusted user message. Do not retry logging; present the estimate and ask whether to log it." };
      }
    }, { priority: 200 });
    api.on("reply_payload_sending", (event) => {
      const turn = event.runId ? this.runs.get(event.runId) : undefined;
      if (!turn || event.kind !== "final" || event.payload.isFallbackNotice || isFallbackNotice(event.payload.text)) return;
      if (turn.fallbackSent) {
        // The SDK can queue its own final error after emitting lifecycle/error.
        // Allow our one queued failure, then suppress duplicate terminal replies.
        if (turn.delivered || event.payload.channelData?.clawfitTerminalReply !== turn.runId) return { cancel: true, reason: "clawfit-terminal-reply-already-queued" };
      }
      turn.delivered = true;
    }, { priority: 200 });
    api.on("before_agent_finalize", (_event, context) => {
      if (context.runId && this.runs.get(context.runId)?.failure) return { action: "finalize", reason: "ClawFit tool failed terminally for this turn; no revision or retries." };
    }, { priority: 200 });
    // The host terminal lifecycle event occurs after model failover is exhausted.
    // agent_end occurs per attempt and must not generate premature failure replies.
    api.agent?.events?.registerAgentEventSubscription({
      id: "clawfit-terminal-reply", streams: ["lifecycle"],
      handle: (event) => {
        if (event.data.phase !== "error" && event.data.phase !== "end") return;
        const turn = this.runs.get(event.runId);
        if (!turn) return;
        if (turn.canDeliver && !turn.delivered && !turn.fallbackSent && (event.data.phase === "error" || turn.failure)) {
          turn.fallbackSent = turn.dispatcher.sendFinalReply({ text: turn.failure?.message ?? TEMPORARY_FAILURE, channelData: { clawfitTerminalReply: turn.runId } });
        }
      },
    });
  }

  forCall(context: OpenClawPluginToolContext, callId: string): InboundTurn | undefined {
    this.prune();
    const turn = context.sessionKey ? this.calls.get(this.callKey(context.sessionKey, callId)) : undefined;
    if (!turn || turn.senderId !== context.requesterSenderId || turn.conversationId !== context.deliveryContext?.to
      || (turn.accountId && turn.accountId !== context.agentAccountId) || context.messageChannel !== "whatsapp") return;
    return turn;
  }

  authorization(turn: InboundTurn | undefined, context: OpenClawPluginToolContext): MediaAuthorizationContext {
    return {
      senderId: context.requesterSenderId, conversationId: context.deliveryContext?.to,
      workspaceDir: context.workspaceDir,
      authorizedAttachments: turn?.paths.map(filePath => ({ path: filePath, senderId: turn.senderId, conversationId: turn.conversationId })),
    };
  }

  writeBlock(turn: InboundTurn | undefined, toolName: string): string | undefined {
    if (!MEAL_WRITES.has(toolName)) return;
    if (!turn) return "Missing trusted current-message context; no draft or meal was changed.";
    if (turn.failure) return turn.failure.message;
    if (isNoSaveRequest(turn.text)) return "The user requested no saving; no draft or meal was changed.";
    // Enforcement here also applies if the runtime invokes a factory tool directly.
    if ((toolName === "log_meal" || toolName === "confirm_pending_meal") && !isMealLogConfirmation(turn.text)) return "Please confirm logging this meal first.";
  }

  fail(turn: InboundTurn | undefined, toolName: string, failure: NonNullable<InboundTurn["failure"]>) {
    if (!turn) return;
    turn.failure = failure;
    turn.failedTools.add(toolName);
  }

  private bind(runId: string, turn: InboundTurn) { turn.runId = runId; this.runs.set(runId, turn); }
  private callKey(sessionKey: string, callId: string) { return JSON.stringify([sessionKey, callId]); }
  private prune() {
    const cutoff = Date.now() - 30 * 60_000;
    this.turns = this.turns.filter(t => t.receivedAt >= cutoff).slice(-256);
    const retained = new Set(this.turns);
    for (const [key, turn] of this.runs) if (!retained.has(turn)) this.runs.delete(key);
    for (const [key, turn] of this.calls) if (!retained.has(turn)) this.calls.delete(key);
    // Bound tool-call metadata too, including pathological model retry loops.
    while (this.calls.size > 2048) this.calls.delete(this.calls.keys().next().value!);
  }
}

export const inboundTurns = new WeakMap<OpenClawPluginApi, InboundTurns>();
