import { z } from "zod";

export const confidenceSchema = z.enum(["high", "medium", "low"]);

export const nutritionItemSchema = z.object({
  name: z.string().min(1).max(200),
  portionDescription: z.string().min(1).max(500),
});

export const nutritionEstimateSchema = z
  .object({
    label: z.string().min(1).max(300),
    items: z.array(nutritionItemSchema).max(30),
    calories: z.object({
      best: z.number().int().nonnegative().max(20_000),
      low: z.number().int().nonnegative().max(20_000),
      high: z.number().int().nonnegative().max(20_000),
    }),
    macros: z.object({
      proteinG: z.number().nonnegative().max(2_000),
      carbsG: z.number().nonnegative().max(3_000),
      fatG: z.number().nonnegative().max(2_000),
      fiberG: z.number().nonnegative().max(500).nullable(),
    }),
    confidence: confidenceSchema,
    uncertaintyReasons: z.array(z.string().min(1).max(300)).max(20),
  })
  .superRefine((estimate, ctx) => {
    if (estimate.calories.low > estimate.calories.best) {
      ctx.addIssue({ code: "custom", path: ["calories", "low"], message: "low must not exceed best" });
    }
    if (estimate.calories.best > estimate.calories.high) {
      ctx.addIssue({ code: "custom", path: ["calories", "high"], message: "high must not be below best" });
    }
    if (estimate.confidence === "low" && estimate.calories.low === estimate.calories.high) {
      ctx.addIssue({ code: "custom", path: ["calories"], message: "low-confidence estimates require a range" });
    }
  });

export const mealInputSchema = nutritionEstimateSchema.extend({
  occurredAt: z.coerce.date(),
  source: z.enum(["text", "photo", "preset", "manual"]),
  rawUserText: z.string().max(4_000).nullable(),
  idempotencyKey: z.string().min(8).max(200),
});

export const mealPatchSchema = z.object({
  occurredAt: z.coerce.date().optional(),
  label: z.string().min(1).max(300).optional(),
  caloriesBest: z.number().int().nonnegative().max(20_000).optional(),
  caloriesLow: z.number().int().nonnegative().max(20_000).optional(),
  caloriesHigh: z.number().int().nonnegative().max(20_000).optional(),
  proteinG: z.number().nonnegative().max(2_000).optional(),
  carbsG: z.number().nonnegative().max(3_000).optional(),
  fatG: z.number().nonnegative().max(2_000).optional(),
  fiberG: z.number().nonnegative().max(500).nullable().optional(),
  confidence: confidenceSchema.optional(),
  uncertaintyReasons: z.array(z.string().min(1).max(300)).max(20).optional(),
});

export const startWorkoutSchema = z.object({
  name: z.string().min(1).max(120),
  startedAt: z.coerce.date().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export const workoutSetInputSchema = z.object({
  exerciseName: z.string().min(1).max(160),
  weightKg: z.number().nonnegative().max(1_000).nullable(),
  reps: z.number().int().positive().max(1_000),
  rpe: z.number().min(1).max(10).nullable().optional(),
  notes: z.string().max(1_000).nullable().optional(),
  occurredAt: z.coerce.date().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export const workoutSetPatchSchema = z.object({
  weightKg: z.number().nonnegative().max(1_000).nullable().optional(),
  reps: z.number().int().positive().max(1_000).optional(),
  rpe: z.number().min(1).max(10).nullable().optional(),
  notes: z.string().max(1_000).nullable().optional(),
});

export type Confidence = z.infer<typeof confidenceSchema>;
export type NutritionEstimate = z.infer<typeof nutritionEstimateSchema>;
export type MealInput = z.infer<typeof mealInputSchema>;
export type MealPatch = z.infer<typeof mealPatchSchema>;
export type WorkoutSetInput = z.infer<typeof workoutSetInputSchema>;
export type WorkoutSetPatch = z.infer<typeof workoutSetPatchSchema>;

