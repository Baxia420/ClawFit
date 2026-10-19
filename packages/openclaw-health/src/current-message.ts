// Only the channel's current command body can authorize an action.
export function currentMessageText(text: string, verifiedBotMention = false): string {
  const current = text.replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, " ")
    .replace(/(?:^|\s)'[^'\n]*'(?=\s|[.!?,]|$)/g, " ");
  // Strip the known bot label only with an explicit channel-verified mention.
  return (verifiedBotMention ? current.replace(/@clawfit\b/gi, " ") : current).trim();
}
