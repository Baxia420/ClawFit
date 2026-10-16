import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const NumberValue = Type.Number({ minimum: 0 });
const Estimate = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 500 }),
  calories: Type.Object({ best: NumberValue, low: NumberValue, high: NumberValue }),
  macros: Type.Object({ proteinG: NumberValue, carbsG: NumberValue, fatG: NumberValue, fiberG: Type.Union([NumberValue, Type.Null()]) }),
  confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  uncertaintyReasons: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
});
export type ReplyEstimate = Static<typeof Estimate>;

export function readReplyEstimate(value: unknown): ReplyEstimate | undefined {
  const nested = value && typeof value === "object" && "estimate" in value ? value.estimate : value;
  if (!Check(Estimate, nested)) return;
  if (nested.calories.low > nested.calories.best || nested.calories.best > nested.calories.high) return;
  return nested;
}

export const NUTRITION_BASIS = "Estimated from the supplied photos and description; no online lookup or manufacturer verification was performed. Unstated serving weights are assumptions.";

export function isNutritionSourceQuestion(text: string): boolean {
  return /\b(?:did|have)\s+you\b|\bwhere\b.*\bfrom|\bhow\b.*\bcalculat|\b(?:source|basis)\s+(?:for|of)\b/i.test(text)
    && /\b(nutrition(?:al)?|calori(?:e|es)|macros?|values?|numbers?|estimat\w*|calculat\w*)\b/i.test(text)
    && /\b(online|sources?|databases?)\b|look(?:ed)?\s*up|where\b.*\bfrom|how\b.*\bcalculat/i.test(text)
    && !/\b(log|save|delete|remove|correct|change|update)\b/i.test(text);
}

export function nutritionReply(estimate: ReplyEstimate, logged: boolean, noSave: boolean, partiallyLogged = false): string {
  const { calories, macros } = estimate;
  return [
    estimate.label,
    `Estimated calories: ${calories.best} kcal (${calories.low}–${calories.high}).`,
    `Protein: ${macros.proteinG} g · Carbs: ${macros.carbsG} g · Fat: ${macros.fatG} g${macros.fiberG === null ? "" : ` · Fiber: ${macros.fiberG} g`}.`,
    `Confidence: ${estimate.confidence}.`,
    ...estimate.uncertaintyReasons.map(reason => `Uncertainty: ${reason}`),
    "Photo/text estimate; not verified against an online product source.",
    partiallyLogged ? "Some meals were logged; others remain pending. Check your meals before retrying." : logged ? "Logged." : noSave ? "Not logged." : "Not logged. Reply yes to log it.",
  ].join("\n");
}
