// Deliberately narrow: a message that also describes a meal must still reach
// the agent. This handles check-ins during an outage without calling a model.
export function isCheckIn(text: string): boolean {
  const body = text.trim().replace(/^(?:@?(?:clawfit|\d{8,15})[,\s:]+)+/i, "").replace(/[?!.]+$/g, "").trim();
  return /^(?:(?:hey|hi|hello)[,\s]+)?(?:are (?:you|u) (?:ok(?:ay)?|there|working|alive)|(?:you|u) (?:ok(?:ay)?|there)|can (?:you|u) (?:hear|read) me|is (?:the )?bot (?:working|online))$/i.test(body);
}

export const CHECK_IN_REPLY = "I'm here and receiving your messages. This checks the chat connection; meal estimation may still be unavailable.";

export function currentMessageContext(text: string, imageCount: number): string {
  return `Current WhatsApp message (quoted user input): ${JSON.stringify(text.slice(0, 4_000))}\nCurrent attached images: ${imageCount}. Act only on this message. Earlier failed or unanswered requests are not queued work. Do not estimate or save an earlier meal unless the current message explicitly requests it. If a retry needs an earlier photo, ask for it again.`;
}
