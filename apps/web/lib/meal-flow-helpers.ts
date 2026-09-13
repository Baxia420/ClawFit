import {
  type NutritionItem,
  type Confidence,
} from "@clawfit/health-core";

export type MealDraft = {
  id?: string | undefined;
  label: string;
  items: NutritionItem[];
  calories: { best: number; low: number; high: number };
  macros: { proteinG: number; carbsG: number; fatG: number; fiberG: number | null };
  confidence: Confidence;
  uncertaintyReasons: string[];
  operationId: string;
  source: "photo" | "text" | "preset" | "manual";
  saveKey?: string | undefined;
  version: number;
  confirmed?: boolean | undefined;
  cancelledAt?: string | null | undefined;
};

export function serializeMealContext(
  description: string,
  notes: string,
  revisionHistory: string[],
  revisionOpId?: string | undefined,
): string {
  return JSON.stringify({
    text: description.trim(),
    notes: notes.trim(),
    revisionHistory,
    ...(revisionOpId ? { revisionOpId } : {}),
  });
}

export function deserializeMealContext(rawText: string | null | undefined): {
  text: string;
  notes: string;
  revisionHistory: string[];
  revisionOpId?: string | undefined;
} {
  if (!rawText || !rawText.trim()) {
    return { text: "", notes: "", revisionHistory: [] };
  }
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        text: typeof parsed.text === "string" ? parsed.text : "",
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        revisionHistory: Array.isArray(parsed.revisionHistory) ? parsed.revisionHistory.map(String) : [],
        revisionOpId: typeof parsed.revisionOpId === "string" ? parsed.revisionOpId : undefined,
      };
    }
  } catch {
    // Legacy plain string fallback
  }
  return { text: rawText, notes: "", revisionHistory: [] };
}

export function parseAuthoritativeDraft(p: Record<string, unknown>): {
  draft: MealDraft;
  context: { text: string; notes: string; revisionHistory: string[]; revisionOpId?: string | undefined };
  confirmed: boolean;
  cancelled: boolean;
} {
  const confirmed = Boolean(p.confirmed);
  const cancelled = Boolean(p.cancelledAt);
  const draft: MealDraft = {
    id: String(p.id),
    label: String(p.label),
    items: Array.isArray(p.items) ? (p.items as NutritionItem[]) : [],
    calories: {
      best: Number(p.caloriesBest ?? 0),
      low: Number(p.caloriesLow ?? p.caloriesBest ?? 0),
      high: Number(p.caloriesHigh ?? p.caloriesBest ?? 0),
    },
    macros: {
      proteinG: Number(p.proteinG ?? 0),
      carbsG: Number(p.carbsG ?? 0),
      fatG: Number(p.fatG ?? 0),
      fiberG: typeof p.fiberG === "number" ? p.fiberG : null,
    },
    confidence: (p.confidence as Confidence) || "medium",
    uncertaintyReasons: Array.isArray(p.uncertaintyReasons) ? (p.uncertaintyReasons as string[]) : [],
    operationId: String(p.idempotencyKey || `draft_${p.id}`),
    source: (p.source as MealDraft["source"]) || "text",
    saveKey: `confirm_${p.id}`,
    version: typeof p.version === "number" ? p.version : 1,
    confirmed,
    cancelledAt: typeof p.cancelledAt === "string" ? p.cancelledAt : null,
  };
  const context = deserializeMealContext(typeof p.rawUserText === "string" ? p.rawUserText : null);
  return { draft, context, confirmed, cancelled };
}
