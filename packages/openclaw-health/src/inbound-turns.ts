import type { OpenClawPluginApi, OpenClawPluginToolContext, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { abortAgentHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { randomUUID } from "node:crypto";
import { isMealLogConfirmation, isNoSaveRequest, isFallbackNotice, TEMPORARY_FAILURE } from "./confirmation.js";
import type { MediaAuthorizationContext } from "./media-resolver.js";

export { TEMPORARY_FAILURE } from "./confirmation.js";
export const MEDIA_FAILURE = "I couldn't access that photo safely. Please resend it in this chat; I won't retry this image in this turn.";
export const MESSAGE_FAILURE = "I couldn't verify this request safely. Please check your meals and resend your request.";
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
  estimation?: Promise<unknown>;
  photoDraft?: Promise<unknown>;
  dispatcher: PluginHookReplyDispatchContext["dispatcher"];
  canDeliver: boolean;
  closed?: boolean;
}

// The host can register the plugin again for read-only tool discovery. Its
// factory API is not necessarily the API which received the active hooks.
// Share hook-issued receipts and bounded turn metadata across registrations/
// module copies, never a "latest photo" lookup. Receipts require full identity.
const CALL_RECEIPTS = Symbol.for("clawfit-health.inbound-call-receipts.v1");
const CALL_GRANT_PARAM = "__clawfitInboundCallGrant";
type CallReceipt = { turn: InboundTurn; toolName: string; callId: string; receivedAt: number };
type RejectedRun = { failure: NonNullable<InboundTurn["failure"]>; receivedAt: number; delivered: boolean; queued?: boolean };
type TurnState = { turns: InboundTurn[]; runs: Map<string, InboundTurn>; rejectedRuns: Map<string, RejectedRun> };
const TURN_STATE = Symbol.for("clawfit-health.inbound-turn-state.v1");
const host = globalThis as typeof globalThis & { [CALL_RECEIPTS]?: Map<string, CallReceipt>; [TURN_STATE]?: TurnState };
// The host can replace its active registry between dispatch and prompt build,
// not just create a discovery registry. Keep bounded metadata across that handoff.
const turnState = host[TURN_STATE] ??= { turns: [], runs: new Map(), rejectedRuns: new Map() };
const callReceipts = host[CALL_RECEIPTS] ??= new Map<string, CallReceipt>();
type DiagnosticReason = "failure_reply" | "turn_captured" | "missing_inbound_identity" | "run_bound" | "run_unbound" | "call_bound" | "call_unbound" | "missing_call_receipt" | "closed_turn" | "identity_mismatch" | "call_authorized" | "media_resolved" | "unauthorized_media" | "image_not_found" | "invalid_image_content" | "oversized_image" | "path_traversal" | "symlink_escape" | "too_many_images";

// Ephemeral metadata only. Never infer ownership from the prompt, model
// parameters, session history, or a directory's contents.
export class InboundTurns {
  private readonly state = turnState;

  constructor(private api: OpenClawPluginApi) {
    api.on("reply_dispatch", (event, context) => {
      this.prune();
      const msg = event.ctx;
      const provider = msg.OriginatingChannel ?? msg.Provider ?? msg.Surface;
      const sessionKey = event.sessionKey ?? msg.SessionKey;
      const senderId = msg.SenderId;
      const conversationId = msg.OriginatingTo ?? msg.To;
      const messageId = msg.MessageSidFull ?? msg.MessageSid;
      const accountId = msg.AccountId ?? event.originatingAccountId;
      if (provider !== "whatsapp") return;
      if (!sessionKey || !senderId || !conversationId || !messageId) {
        this.diagnostic("missing_inbound_identity", undefined, {
          hasSession: Boolean(sessionKey), hasSender: Boolean(senderId), hasConversation: Boolean(conversationId), hasMessage: Boolean(messageId),
        });
        return;
      }
      // Tail dispatch is the same inbound message, not a new authorization grant.
      if (this.state.turns.some(t => t.sessionKey === sessionKey && t.messageId === messageId
        && t.senderId === senderId && t.conversationId === conversationId
        && normalizeAccountId(t.accountId) === normalizeAccountId(accountId))) return;
      const paths = [...new Set([...(msg.MediaPaths ?? []), ...(msg.MediaPath ? [msg.MediaPath] : [])])];
      const turn: InboundTurn = {
        sessionKey, senderId, conversationId, messageId,
        accountId,
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
      this.state.turns.push(turn);
      this.diagnostic("turn_captured", turn, { hasDispatchRun: Boolean(event.runId), canDeliver: turn.canDeliver, sendAllowed: event.sendPolicy === "allow", suppressed: Boolean(event.suppressUserDelivery), routed: Boolean(event.shouldRouteToOriginating) });
      if (event.runId) this.bind(event.runId, turn);
    });
    api.on("before_prompt_build", (_event, context) => {
      this.prune();
      // Memory flushes reuse the user session/sender but are separate runs with
      // filesystem-only tools. They must never consume a pending user grant.
      if (context.trigger && context.trigger !== "user") return;
      if (!context.runId || this.state.runs.has(context.runId) || this.state.rejectedRuns.has(context.runId)) return; // retain across model failover
      const candidates = this.state.turns.filter(t => !t.closed && !t.runId && t.sessionKey === context.sessionKey
        && t.senderId === context.senderId && t.conversationId === (context.chatId ?? context.channelId));
      if (candidates.length === 1 && candidates[0]) this.bind(context.runId, candidates[0]);
      else this.diagnostic("run_unbound", undefined, { candidateCount: candidates.length, hasSession: Boolean(context.sessionKey), hasSender: Boolean(context.senderId), hasConversation: Boolean(context.chatId ?? context.channelId) });
    }, { priority: 200 });
    api.on("before_tool_call", async (event, context) => {
      this.prune();
      const runId = context.runId ?? event.runId;
      const turn = runId ? this.state.runs.get(runId) : undefined;
      const callId = event.toolCallId ?? context.toolCallId;
      const bindingValid = turn && !turn.closed && callId && context.sessionKey === turn.sessionKey
        && (!event.runId || !context.runId || event.runId === context.runId);
      let grantedParams: { params: Record<string, unknown> } | undefined;
      if (bindingValid) {
        // Call IDs need only be unique inside a run. The host wrapper forwards
        // this hook's adjusted params to execute, even for cached descriptors
        // whose factory belongs to another registration. Never expose the
        // unpredictable grant in the model-facing schema or tool result.
        const grant = randomUUID();
        callReceipts.set(grant, { turn, toolName: event.toolName, callId, receivedAt: Date.now() });
        grantedParams = { params: { ...event.params, [CALL_GRANT_PARAM]: grant } };
        this.diagnostic("call_bound", turn);
      } else if (event.toolName === "estimate_nutrition" || MEAL_WRITES.has(event.toolName)) {
        this.diagnostic("call_unbound", turn, { hasRun: Boolean(runId), hasCall: Boolean(callId), hasSession: Boolean(context.sessionKey) });
        if (turn) this.fail(turn, event.toolName, { error: "untrusted_message", message: event.toolName === "estimate_nutrition" ? MEDIA_FAILURE : MESSAGE_FAILURE, retryable: false });
      }
      // A missing binding grants no attachments. Also keep failure-only state
      // so an unbound run cannot turn a veto into guessed nutrition or a write.
      if (runId && !turn && (event.toolName === "estimate_nutrition" || MEAL_WRITES.has(event.toolName)) && !this.state.rejectedRuns.has(runId)) {
        this.state.rejectedRuns.set(runId, { failure: { error: "untrusted_message", message: event.toolName === "estimate_nutrition" ? MEDIA_FAILURE : MESSAGE_FAILURE, retryable: false }, receivedAt: Date.now(), delivered: false });
        // Retire ambiguous/unbound grants instead of letting them poison the
        // next message's candidate search or become stale photo fallbacks.
        for (const pending of this.state.turns) if (!pending.runId && pending.sessionKey === context.sessionKey) pending.closed = true;
      }
      const rejected = runId ? this.state.rejectedRuns.get(runId) : undefined;
      const terminalFailure = rejected?.failure ?? turn?.failure;
      if (terminalFailure) {
        // A textual veto alone invites another model/tool cycle. Cancel the
        // exact session from this host hook, never a latest-session
        // lookup, delayed callback, or global cancellation. Queue a safe reply
        // first when we have its original trusted dispatcher.
        // A lost lookup is not permission to reconstruct a grant. An exact
        // already-recorded run/session may still deliver its failure through
        // its own dispatcher; never use a different or most recent turn.
        const replyTurn = turn ?? this.state.turns.find(t => !t.closed && t.runId === runId && t.sessionKey === context.sessionKey);
        if (replyTurn) {
          if (rejected) replyTurn.failure = rejected.failure;
          this.sendFailure(replyTurn);
          if (rejected) rejected.queued = replyTurn.fallbackSent;
          // Cancellation also aborts the reply operation. Drain the trusted
          // dispatcher before stopping the model so its error is not discarded.
          if (replyTurn.fallbackSent) await replyTurn.dispatcher.waitForIdle();
        }
        if (context.sessionId && !turn?.closed) abortAgentHarnessRun(context.sessionId);
        return { block: true, blockReason: `${terminalFailure.message} Do not retry or save a meal in this turn.` };
      }
      if (!MEAL_WRITES.has(event.toolName)) return grantedParams;
      if (!bindingValid) return { block: true, blockReason: "Missing trusted current-message context. Do not save a draft or meal; ask the user to resend their request." };
      if (isNoSaveRequest(turn.text)) {
        return { block: true, blockReason: "The user explicitly requested no saving. Do not create or modify a pending draft or logged meal." };
      }
      if ((event.toolName === "log_meal" || event.toolName === "confirm_pending_meal") && !isMealLogConfirmation(turn.text)) {
        return { block: true, blockReason: "No confirmation in the current trusted user message. Do not retry logging; present the estimate and ask whether to log it." };
      }
      return grantedParams;
    }, { priority: 200 });
    api.on("reply_payload_sending", (event) => {
      const turn = event.runId ? this.state.runs.get(event.runId) : undefined;
      if (event.kind !== "final" || event.payload.isFallbackNotice || isFallbackNotice(event.payload.text)) return;
      const rejected = event.runId ? this.state.rejectedRuns.get(event.runId) : undefined;
      if (!turn && rejected) {
        // Our dispatcher queued this exact run's safe terminal reply before
        // cancellation. Other final payloads from it must stay suppressed.
        if (rejected.queued && event.payload.channelData?.clawfitTerminalReply !== event.runId) return { cancel: true, reason: "clawfit-terminal-reply-already-queued" };
        if (rejected.delivered) return { cancel: true, reason: "clawfit-failure-already-delivered" };
        rejected.delivered = true;
        return { payload: { text: rejected.failure.message, isError: true } };
      }
      if (!turn) return;
      if (turn.fallbackSent) {
        // The SDK can queue its own final error after emitting lifecycle/error.
        // Allow our one queued failure, then suppress duplicate terminal replies.
        if (turn.delivered || event.payload.channelData?.clawfitTerminalReply !== turn.runId) return { cancel: true, reason: "clawfit-terminal-reply-already-queued" };
      }
      if (turn.failure) {
        if (turn.delivered) return { cancel: true, reason: "clawfit-failure-already-delivered" };
        turn.delivered = true;
        // Do not allow a general-agent guess, stale estimate, attachment or
        // logging offer to turn a failed tool result into apparent success.
        return { payload: { text: turn.failure.message, isError: true } };
      }
      turn.delivered = true;
    }, { priority: 200 });
    api.on("before_agent_finalize", (_event, context) => {
      if (context.runId && (this.state.runs.get(context.runId)?.failure || this.state.rejectedRuns.has(context.runId))) return { action: "finalize", reason: "ClawFit tool failed terminally for this turn; no revision or retries." };
    }, { priority: 200 });
    // The host terminal lifecycle event occurs after model failover is exhausted.
    // agent_end occurs per attempt and must not generate premature failure replies.
    api.agent?.events?.registerAgentEventSubscription({
      id: "clawfit-terminal-reply", streams: ["lifecycle"],
      handle: (event) => {
        if (event.data.phase !== "error" && event.data.phase !== "end") return;
        const turn = this.state.runs.get(event.runId);
        if (!turn) return;
        if (event.data.phase === "error" || turn.failure) this.sendFailure(turn);
        turn.closed = true;
      },
    });
  }

  private sendFailure(turn: InboundTurn) {
    if (turn.canDeliver && !turn.delivered && !turn.fallbackSent) {
      turn.fallbackSent = turn.dispatcher.sendFinalReply({ text: turn.failure?.message ?? TEMPORARY_FAILURE, isError: true, channelData: { clawfitTerminalReply: turn.runId } });
      this.diagnostic("failure_reply", turn, { queued: turn.fallbackSent });
    }
  }

  forCall(context: OpenClawPluginToolContext, callId: string, toolName: string, params: unknown): InboundTurn | undefined {
    this.prune();
    const receipt = this.receipt(params, callId, toolName);
    const turn = receipt?.turn;
    if (!turn) { this.diagnostic("missing_call_receipt"); return; }
    if (turn.closed) { this.diagnostic("closed_turn", turn); return; }
    if (turn.sessionKey !== context.sessionKey || turn.senderId !== context.requesterSenderId || turn.conversationId !== context.deliveryContext?.to
      || normalizeAccountId(turn.accountId) !== normalizeAccountId(context.agentAccountId)
      || (context.deliveryContext.accountId !== undefined && normalizeAccountId(turn.accountId) !== normalizeAccountId(context.deliveryContext.accountId))
      || context.messageChannel !== "whatsapp") {
      this.diagnostic("identity_mismatch", turn, { hasSender: Boolean(context.requesterSenderId), hasConversation: Boolean(context.deliveryContext?.to), hasAccount: Boolean(context.agentAccountId) });
      return;
    }
    this.diagnostic("call_authorized", turn);
    return turn;
  }

  parametersForCall(params: unknown, callId: string, toolName: string): unknown {
    // Only strip a genuine host-issued field. An invented model field remains
    // an extra property and is rejected by estimate_nutrition's strict schema.
    if (!this.receipt(params, callId, toolName)) return params;
    const { [CALL_GRANT_PARAM]: _grant, ...request } = params as Record<string, unknown>;
    return request;
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
    if (turn.closed) return "This inbound turn has ended; no draft or meal was changed.";
    if (turn.failure) return turn.failure.message;
    if (isNoSaveRequest(turn.text)) return "The user requested no saving; no draft or meal was changed.";
    // Enforcement here also applies if the runtime invokes a factory tool directly.
    if ((toolName === "log_meal" || toolName === "confirm_pending_meal") && !isMealLogConfirmation(turn.text)) return "Please confirm logging this meal first.";
  }

  fail(turn: InboundTurn | undefined, toolName: string, failure: NonNullable<InboundTurn["failure"]>) {
    if (!turn) return;
    turn.failure = failure;
    turn.failedTools.add(toolName);
    // Tool execution has already exhausted API fallbacks. Do not depend on a
    // provider lifecycle event or a model final answer (which may be NO_REPLY).
    this.sendFailure(turn);
  }

  failCall(context: OpenClawPluginToolContext, callId: string, toolName: string, params: unknown, failure: NonNullable<InboundTurn["failure"]>) {
    const receipt = this.receipt(params, callId, toolName);
    // Failure propagation is not an attachment authorization grant. It ensures
    // a factory identity mismatch still suppresses guesses in the owning run.
    if (receipt && receipt.turn.sessionKey === context.sessionKey) this.fail(receipt.turn, toolName, failure);
  }

  estimateOnce(turn: InboundTurn, execute: () => Promise<unknown>): Promise<unknown> {
    // Store the promise before work starts so concurrent tool calls for the
    // same album share one read/estimate. Ownership is checked before this.
    return turn.estimation ??= Promise.resolve().then(execute);
  }

  photoDraftOnce(turn: InboundTurn, execute: () => Promise<unknown>): Promise<unknown> {
    // All photos in this inbound collection describe one combined estimate.
    // Duplicate model calls must not create another draft with a new key.
    return turn.photoDraft ??= Promise.resolve().then(execute);
  }

  diagnostic(reason: DiagnosticReason, turn?: InboundTurn, metadata: Record<string, boolean | number> = {}) {
    // Fixed codes, counts and booleans only: no IDs, paths, captions or errors.
    this.api.logger?.info(`[clawfit-media] ${JSON.stringify({ reason, attachmentCount: turn?.paths.length ?? 0, bound: Boolean(turn?.runId), hasTrustedMetadata: Boolean(turn), hasInboundAccount: Boolean(turn?.accountId), activeRegistration: this.api.registrationMode === "full", ...metadata })}`);
  }

  private bind(runId: string, turn: InboundTurn) { turn.runId = runId; this.state.runs.set(runId, turn); this.diagnostic("run_bound", turn); }
  private receipt(params: unknown, callId: string, toolName: string): CallReceipt | undefined {
    const grant = params && typeof params === "object" ? (params as Record<string, unknown>)[CALL_GRANT_PARAM] : undefined;
    const receipt = typeof grant === "string" ? callReceipts.get(grant) : undefined;
    return receipt?.callId === callId && receipt.toolName === toolName ? receipt : undefined;
  }
  private prune() {
    const cutoff = Date.now() - 30 * 60_000;
    const remaining = this.state.turns.filter(t => t.receivedAt >= cutoff).slice(-256);
    const retained = new Set(remaining);
    for (const turn of this.state.turns) if (!retained.has(turn)) turn.closed = true;
    this.state.turns = remaining;
    for (const [key, turn] of this.state.runs) if (!retained.has(turn)) this.state.runs.delete(key);
    for (const [key, state] of this.state.rejectedRuns) if (state.receivedAt < cutoff) this.state.rejectedRuns.delete(key);
    while (this.state.rejectedRuns.size > 256) this.state.rejectedRuns.delete(this.state.rejectedRuns.keys().next().value!);
    for (const [key, receipt] of callReceipts) if (receipt.receivedAt < cutoff || (receipt.turn && receipt.turn.receivedAt < cutoff)) callReceipts.delete(key);
    // Bound tool-call metadata too, including pathological model retry loops.
    while (callReceipts.size > 2048) callReceipts.delete(callReceipts.keys().next().value!);
  }
}

export const inboundTurns = new WeakMap<OpenClawPluginApi, InboundTurns>();
