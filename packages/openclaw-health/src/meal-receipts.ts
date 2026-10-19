import { isDraftCancellationRequest, isMealLogConfirmation } from "./confirmation.js";
import { currentMessageText } from "./current-message.js";
import type { ReplyEstimate } from "./nutrition-reply.js";

export type MealReceipt = { action: "draft_created" | "draft_updated" | "logged" | "updated" | "deleted" | "cancelled" | "already_cancelled" | "not_found" | "expired" | "already_confirmed"; id?: string; recipient?: { userId: string; displayName: string } };
export type MealEvidence = { text: string; mealReceipts?: MealReceipt[]; pendingDrafts?: unknown[]; verifiedRecipient?: { userId: string; displayName: string }; otherActionCompleted?: boolean; mealPartiallyLogged?: boolean };
const row = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const idOf = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

function recipientOf(value: unknown): MealReceipt["recipient"] {
  const profile = row(value);
  return profile && idOf(profile.userId) && typeof profile.displayName === "string" && profile.displayName.length > 0 && profile.displayName.length <= 120
    ? { userId: profile.userId as string, displayName: profile.displayName } : undefined;
}

export function recordMealResult(state: MealEvidence, tool: string, result: unknown): void {
  const value = row(result);
  if (!value || value.error) return;
  const recipient = recipientOf(value.recipient);
  if (recipient) state.verifiedRecipient = recipient;
  const record = (action: MealReceipt["action"], id?: string, profile = recipient) => {
    if (state.mealReceipts?.some(receipt => receipt.action === action && receipt.id === id)) return;
    (state.mealReceipts ??= []).push({ action, ...(id ? { id } : {}), ...(profile ? { recipient: profile } : {}) });
  };
  const id = idOf(value.id);
  if (id && ["start_workout", "add_workout_set", "update_workout_set", "delete_workout_set", "finish_workout", "save_food_preset", "update_food_preset", "delete_food_preset"].includes(tool)) state.otherActionCompleted = true;
  if (tool === "get_pending_meal") state.pendingDrafts = Array.isArray(value.pendingMeals) ? value.pendingMeals : id ? [value] : [];
  if ((tool === "create_pending_meal" || tool === "update_pending_meal") && id) {
    state.pendingDrafts = [value];
    record(tool === "create_pending_meal" ? "draft_created" : "draft_updated", id);
  }
  if (tool === "delete_pending_meal" && ["cancelled", "already_cancelled", "not_found", "expired", "already_confirmed"].includes(String(value.status))) {
    record(value.status as MealReceipt["action"], idOf(value.pendingDraftId));
    state.pendingDrafts = [];
  }
  if (tool === "log_meal" && id) record("logged", id);
  if (tool === "confirm_pending_meal") {
    state.mealPartiallyLogged = value.status === "partial_success";
    if (value.status === "confirmed" && id) record("logged", id);
    if (Array.isArray(value.confirmedMeals)) for (const meal of value.confirmedMeals) {
      const entry = row(meal), mealId = idOf(entry?.confirmedMealId);
      if (entry?.status === "confirmed" && mealId) record("logged", mealId, recipientOf(entry.recipient));
    }
    if (value.status === "confirmed") state.pendingDrafts = [];
  }
  if (tool === "update_meal" && id) record("updated", id);
  if (tool === "delete_meal" && id) record("deleted", id);
}

export function hasMatchingDraft(state: MealEvidence, estimate: ReplyEstimate): boolean {
  if (state.pendingDrafts?.length !== 1) return false;
  return (state.pendingDrafts ?? []).some(draft => {
    const value = row(draft);
    if (!value || !idOf(value.id) || value.confirmed || value.cancelledAt || typeof value.expiresAt !== "string" || Date.parse(value.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(value.expiresAt))) return false;
    const calories = row(value.calories);
    const macros = row(value.macros);
    return value.label === estimate.label
      && (value.caloriesBest ?? calories?.best) === estimate.calories.best
      && (value.caloriesLow ?? calories?.low) === estimate.calories.low
      && (value.caloriesHigh ?? calories?.high) === estimate.calories.high
      && (value.proteinG ?? macros?.proteinG) === estimate.macros.proteinG
      && (value.carbsG ?? macros?.carbsG) === estimate.macros.carbsG
      && (value.fatG ?? macros?.fatG) === estimate.macros.fatG;
  });
}

export function isMealOwnershipQuestion(text: string): boolean {
  return /\b(?:whose|who\b.*\b(?:for|belongs?|owns?|meal|food|draft|photo)|which\s+(?:person|profile))\b/i.test(currentMessageText(text));
}

export function hasMealActionClaim(text: string): boolean {
  return text.split(/[.!\n]/).some(sentence => {
    if (/\b(?:not|never|no|couldn['’]?t|haven['’]?t|can['’]?t|cannot|wasn['’]?t|isn['’]?t)\b/i.test(sentence)) return false;
    return /^\s*(?:done|logged|saved|cancelled|cleared|deleted|removed)\b/i.test(sentence)
      || /\b(?:i|i['’]ve|we|it|this|that|(?:the|your)\s+(?:draft|meal))\b[^?]{0,100}\b(?:logged|saved|cancelled|cleared|deleted|removed)\b/i.test(sentence)
      || /\b(?:belongs?\s+to|recipient\s+(?:is|was)|logged\s+for)\b/i.test(sentence);
  });
}

export function mealActionReply(state: MealEvidence): string | undefined {
  const receipts = state.mealReceipts ?? [];
  if (!receipts.length && state.otherActionCompleted) return undefined;
  if (receipts.length) return receipts.map(receipt => {
    const owner = receipt.recipient ? ` for ${receipt.recipient.displayName}` : "";
    switch (receipt.action) {
      case "draft_created": return `Meal draft saved${owner}; it has not been logged.`;
      case "draft_updated": return `Meal draft updated${owner}; it has not been logged.`;
      case "logged": return `Meal logged${owner}.`;
      case "updated": return `Logged meal updated${owner}.`;
      case "deleted": return `Logged meal deleted${owner}.`;
      case "cancelled": return `Pending meal draft cancelled${owner}.`;
      case "already_cancelled": return "That pending meal draft was already cancelled.";
      case "not_found": return "No matching pending meal draft was found. No cancellation was performed.";
      case "expired": return "That meal draft has expired. No cancellation was performed.";
      case "already_confirmed": return "That draft was already logged. The logged meal was left unchanged.";
    }
  }).join("\n") + (state.mealPartiallyLogged ? "\nSome requested confirmations failed. Check your meals and remaining drafts before retrying." : "");
  if (isMealOwnershipQuestion(state.text)) return state.verifiedRecipient
    ? `The API identifies ${state.verifiedRecipient.displayName} as the meal recipient. This does not establish who took or sent the original photo.`
    : "I haven't verified the meal recipient. Please name the person and the meal or draft to check.";
  if (isDraftCancellationRequest(state.text)) return "I couldn't verify a completed draft cancellation in this request. Please check the pending draft before retrying.";
  if (isMealLogConfirmation(state.text)) return "I couldn't verify that a meal was logged in this request. Please check the current meals and pending drafts before retrying.";
  return undefined;
}
