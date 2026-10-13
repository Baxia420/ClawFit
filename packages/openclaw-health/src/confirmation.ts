export const TEMPORARY_FAILURE = "I couldn't complete that just now because the service is temporarily unavailable. Please try again in a moment.";

export function isNoSaveRequest(prompt: string): boolean {
  return /\b(?:do\s+not|don['’]?t|never|without|no)\b[^.!?]{0,60}\b(?:sav(?:e|ed|ing)|log(?:ged|ging)?|track(?:ed|ing)?|record(?:ed|ing)?|persist(?:ing)?|drafts?)\b/i.test(prompt)
    || /\b(?:estimate|estimation|calculate|calculation)\s+only\b/i.test(prompt)
    || /\bonly\s+(?:estimate|calculate)\b/i.test(prompt);
}

export function isMealLogConfirmation(prompt: string | null | undefined): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  // "Log it for Cici and not me" excludes a recipient, not the write itself.
  // Keep all other negative action clauses intact.
  const trimmed = prompt.trim().replace(/\bnot\s+(?:for\s+)?(?:me|myself)\b/gi, "");
  if (!trimmed || isNoSaveRequest(trimmed)) return false;
  const action = "(?:log(?:ged|ging)?|sav(?:e|ed|ing)|track(?:ed|ing)?|record(?:ed|ing)?)";
  if (new RegExp(`\\b(?:do\\s+not|don't|dont|never|without)\\b[^.!?]{0,60}\\b${action}\\b`, "i").test(trimmed)) return false;
  if (new RegExp(`\\b${action}\\b[^.!?]{0,30}\\b(?:not|never)\\b`, "i").test(trimmed)) return false;
  if (new RegExp(`^(?:what|when|where|why|how(?:\\s+much)?|did\\s+i|have\\s+i)\\b[^.!?]*\\b${action}\\b[^.!?]*[?]?$`, "i").test(trimmed)) return false;
  if (/\b(log|save|track|record)\b/i.test(trimmed)) return true;
  return /^\s*(yes|yep|yeah|sure|ok(?:ay)?|confirm|do it|go ahead|please do)[\s.!]*$/i.test(trimmed);
}

export function isFallbackNotice(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  return /^(↪️\s*)?Model Fallback/i.test(text.trim()) || text.includes("selected google/") || text.includes("selected gemini");
}

export function sanitizeUserFacingError(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return TEMPORARY_FAILURE;

  if (text.includes("UNRESOLVED_SENDER_IDENTITY:") || text.includes("This WhatsApp account isn't linked to a ClawFit profile yet.")) {
    return "This WhatsApp account isn't linked to a ClawFit profile yet.";
  }
  if (text.includes("INACTIVE_USER:") || text.includes("This ClawFit profile is inactive.")) {
    return "This ClawFit profile is inactive. Please contact the household administrator.";
  }
  if (text.includes("UNAUTHORIZED_GROUP:") || text.includes("This WhatsApp group is not authorized for ClawFit health tracking.")) {
    return "This WhatsApp group is not authorized for ClawFit health tracking.";
  }
  if (text.includes("MISSING_CONVERSATION_IDENTITY:") || text.includes("Missing WhatsApp conversation context")) {
    return "Missing WhatsApp conversation context. Request cannot be processed.";
  }

  const hasRawError =
    /(?:RESOURCE_EXHAUSTED|SERVICE_UNAVAILABLE)/i.test(text) ||
    /Google Generative AI API error/i.test(text) ||
    /quota exceeded/i.test(text) ||
    /HTTP (?:429|503)/i.test(text) ||
    /assistant turn failed/i.test(text) ||
    /FailoverError/i.test(text) ||
    /HealthApiNetworkError/i.test(text) ||
    /fetch failed/i.test(text) ||
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(text) ||
    /\[code=\w+\]/i.test(text) ||
    /generativelanguage\.googleapis\.com/i.test(text);

  if (hasRawError) {
    return TEMPORARY_FAILURE;
  }
  return text;
}
