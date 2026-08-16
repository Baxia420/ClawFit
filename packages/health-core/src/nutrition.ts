import { nutritionEstimateSchema, type NutritionEstimate } from "./schemas.js";

export type NutritionModelRequest = {
  model: string;
  prompt: string;
  image?: { mimeType: string; base64: string };
};

export interface NutritionModelClient {
  generate(request: NutritionModelRequest): Promise<unknown>;
}

export class NutritionEstimationError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly { model: string; reason: string }[],
  ) {
    super(message);
    this.name = "NutritionEstimationError";
  }
}

export class NutritionEstimator {
  constructor(
    private readonly client: NutritionModelClient,
    private readonly models: readonly string[],
  ) {
    if (models.length === 0) throw new Error("At least one nutrition model is required");
  }

  async estimate(input: { text: string; image?: { mimeType: string; base64: string } }): Promise<{
    estimate: NutritionEstimate;
    model: string;
    fallbackUsed: boolean;
  }> {
    const attempts: { model: string; reason: string }[] = [];
    for (const [index, model] of this.models.entries()) {
      try {
        const raw = await this.client.generate({
          model,
          prompt: nutritionPrompt(input.text),
          ...(input.image ? { image: input.image } : {}),
        });
        return {
          estimate: nutritionEstimateSchema.parse(normalizeNutritionKeys(raw)),
          model,
          fallbackUsed: index > 0,
        };
      } catch (error) {
        attempts.push({ model, reason: error instanceof Error ? error.message : "Unknown model error" });
      }
    }
    throw new NutritionEstimationError("All configured nutrition models failed", attempts);
  }
}

export function nutritionPrompt(userText: string): string {
  return [
    "Estimate the consumed meal's nutrition. Return JSON only.",
    "Use realistic ranges; never imply false precision. Hidden oils, sauces, and restaurant portions lower confidence.",
    "Required keys: label, items[{name, portion_description}], calories{best,low,high},",
    "macros{protein_g,carbs_g,fat_g,fiber_g}, confidence(high|medium|low), uncertainty_reasons[].",
    `User description: ${userText || "No text supplied; infer from the attached meal image."}`,
  ].join("\n");
}

function normalizeNutritionKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => {
        const row = item as Record<string, unknown>;
        return { name: row.name, portionDescription: row.portionDescription ?? row.portion_description };
      })
    : raw.items;
  const macros = (raw.macros ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    items,
    macros: {
      proteinG: macros.proteinG ?? macros.protein_g,
      carbsG: macros.carbsG ?? macros.carbs_g,
      fatG: macros.fatG ?? macros.fat_g,
      fiberG: macros.fiberG ?? macros.fiber_g ?? null,
    },
    uncertaintyReasons: raw.uncertaintyReasons ?? raw.uncertainty_reasons,
  };
}

