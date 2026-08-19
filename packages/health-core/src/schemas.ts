import { z } from "zod";

export const confidenceSchema = z.enum(["high", "medium", "low"]);
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

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

export const pendingMealInputSchema = nutritionEstimateSchema.extend({
  scopeKey: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9:_-]*$/i),
  occurredAt: z.coerce.date().default(() => new Date()),
  source: z.enum(["text", "photo", "preset", "manual"]).default("text"),
  rawUserText: z.string().max(4_000).nullable().optional(),
  idempotencyKey: z.string().min(8).max(200),
  expiresInSeconds: z.number().int().positive().max(86_400).default(7_200),
});

export const confirmPendingMealSchema = z.object({
  scopeKey: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9:_-]*$/i),
  occurredAt: z.coerce.date().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const pendingMealScopeSchema = z.object({
  scopeKey: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9:_-]*$/i),
});

export const pendingMealPatchSchema = z.object({
  label: z.string().min(1).max(300).optional(),
  caloriesBest: z.number().int().nonnegative().max(20_000).optional(),
  caloriesLow: z.number().int().nonnegative().max(20_000).optional(),
  caloriesHigh: z.number().int().nonnegative().max(20_000).optional(),
  proteinG: z.number().nonnegative().max(2_000).optional(),
  carbsG: z.number().nonnegative().max(3_000).optional(),
  fatG: z.number().nonnegative().max(2_000).optional(),
  fiberG: z.number().nonnegative().max(500).nullable().optional(),
});

export const settingsPatchSchema = z.object({
  calorieTarget: z.number().int().min(500).max(10_000).optional(),
  proteinTargetG: z.number().min(10).max(1_000).optional(),
  timezone: timezoneSchema.optional(),
  preferredUnits: z.enum(["metric", "imperial"]).optional(),
});

export const notificationTypes = [
  "meal_reminder",
  "workout_reminder",
  "evening_progress",
  "unfinished_workout",
  "daily_summary",
  "weekly_summary",
] as const;

export const notificationPreferenceSchema = z.object({
  type: z.enum(notificationTypes),
  enabled: z.boolean(),
  timeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  timezone: timezoneSchema,
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length, "Days of week must be unique"),
  deliveryChannel: z.enum(["web_push", "whatsapp", "both"]),
  configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type Confidence = z.infer<typeof confidenceSchema>;
export type NutritionEstimate = z.infer<typeof nutritionEstimateSchema>;
export type MealInput = z.infer<typeof mealInputSchema>;
export type MealPatch = z.infer<typeof mealPatchSchema>;
export type PendingMealInput = z.infer<typeof pendingMealInputSchema>;
export type ConfirmPendingMealInput = z.infer<typeof confirmPendingMealSchema>;
export type PendingMealPatch = z.infer<typeof pendingMealPatchSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;
export type WorkoutSetInput = z.infer<typeof workoutSetInputSchema>;
export type WorkoutSetPatch = z.infer<typeof workoutSetPatchSchema>;
