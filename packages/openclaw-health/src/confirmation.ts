export function isMealLogConfirmation(prompt: string | null | undefined): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
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
  if (!text || typeof text !== "string") return "I couldn't complete that just now. Nothing was changed — try again in a moment.";
  const hasRawError =
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /Google Generative AI API error/i.test(text) ||
    /quota exceeded/i.test(text) ||
    /HTTP 429/i.test(text) ||
    /assistant turn failed/i.test(text) ||
    /FailoverError/i.test(text) ||
    /HealthApiNetworkError/i.test(text) ||
    /fetch failed/i.test(text) ||
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(text) ||
    /\[code=\w+\]/i.test(text) ||
    /generativelanguage\.googleapis\.com/i.test(text);

  if (hasRawError) {
    return "I couldn't complete that just now. Nothing was changed — try again in a moment.";
  }
  return text;
}
