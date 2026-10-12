// Extract only an explicit recipient from the trusted current user message.
// Never infer a beneficiary from a meal label, quoted history, or model output.
export function explicitMealRecipient(text: string): string | undefined {
  if (/\bfor\s+(?:both\s+of\s+us|both\s+us)|\bfor\s+[\p{L}]+\s+and\s+(?!not\b)[\p{L}]+/iu.test(text)) return "unresolved-recipient";
  const name = "([\\p{L}][\\p{L}\\p{N}_'-]{0,79})";
  const flags = "iu";
  const action = "(?:log|save|track|record)";
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
  return undefined;
}
