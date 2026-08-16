export function isMealLogConfirmation(prompt: string) {
  if (/\b(log|save|track|record)\b/i.test(prompt)) return true;
  return /^\s*(yes|yep|yeah|sure|ok(?:ay)?|confirm|do it|go ahead)[\s.!]*$/i.test(prompt);
}
