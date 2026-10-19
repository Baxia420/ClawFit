import { currentMessageText } from "./current-message.js";

// Extract only an explicit recipient from the trusted current user message.
// Never infer a beneficiary from a meal label, quoted history, or model output.
export function explicitMealRecipient(text: string): string | undefined {
  text = currentMessageText(text);
  // These are API-recognized household aliases, not IDs. Membership is still
  // checked by the API. Short answers to a recipient question must not become
  // an implicit self route.
  const short = text.match(/^(?:for\s+)?(Cici|Jobayer|Mahin|partner|my partner|me|myself|self)[.!]?$/i);
  if (short) return /^(?:me|myself|self)$/i.test(short[1]!) ? "self" : /^my partner$/i.test(short[1]!) ? "partner" : short[1];
  if (/\bfor\s+(?:both\s+of\s+us|both\s+us)|\bfor\s+[\p{L}]+\s+and\s+(?!not\b)[\p{L}]+/iu.test(text)) return "unresolved-recipient";
  const name = "([\\p{L}][\\p{L}\\p{N}_'-]{0,79})";
  const flags = "iu";
  const action = "(?:log|save|track|record|cancel|clear|discard|delete|remove|update|correct|estimate|retry|try)";
  const named = text.match(new RegExp(`\\b${action}\\b[^.!?]{0,80}?\\bfor\\s+${name}`, flags))
    ?? text.match(new RegExp(`\\bwhat\\s+(?:did|has)\\s+${name}\\s+(?:eat|eaten|have|had)\\b`, flags));
  if (named) {
    const target = named[1]!;
    if (/^(?:she|he|they)$/i.test(target)) return "unresolved-recipient";
    if (/^(?:i|me|myself|self)$/i.test(target)) return "self";
    if (/^(?:my|her|him|them)$/i.test(target)) {
      const subject = text.match(new RegExp(`(?:^|[.!?]\\s*)${name}\\s+(?:had|ate|has|is|will)\\b`, flags));
      if (subject) return subject[1];
      if (/for\s+my\s+(?:partner|girlfriend|boyfriend|wife|husband)\b/i.test(text)) return "partner";
      return "unresolved-recipient";
    }
    return target;
  }
  if (/\bwhat\s+(?:did|has)\s+(?:she|he|they)\s+(?:eat|eaten|have|had)\b/i.test(text)) return "unresolved-recipient";
  if (/^\s*my\s+(?:partner|girlfriend|boyfriend|wife|husband)\s+(?:had|ate|is\s+having)\b/i.test(text)) return "partner";
  const subject = text.match(new RegExp(`^\\s*${name}\\s+(?:had|ate|is\\s+having)\\b`, flags));
  if (subject) {
    if (/^i$/i.test(subject[1]!)) return "self";
    if (/^(?:she|he|they|we|you)$/i.test(subject[1]!)) return "unresolved-recipient";
    if (/^(?:today|yesterday|tonight|tomorrow|earlier|breakfast|lunch|dinner)$/i.test(subject[1]!)) return undefined;
    return subject[1];
  }
  if (/\b(?:not|isn['’]?t)\s+(?:for\s+)?(?:me|mine|myself|Jobayer|Mahin|Cici)\b/i.test(text)) return "unresolved-recipient";
  return undefined;
}
