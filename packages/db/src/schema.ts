import { boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const confidenceEnum = pgEnum("confidence", ["high", "medium", "low"]);
export const mealSourceEnum = pgEnum("meal_source", ["text", "photo", "preset", "manual"]);
export const workoutStatusEnum = pgEnum("workout_status", ["active", "finished"]);

export const meals = pgTable(
  "meals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    label: varchar("label", { length: 300 }).notNull(),
    caloriesBest: integer("calories_best").notNull(),
    caloriesLow: integer("calories_low").notNull(),
    caloriesHigh: integer("calories_high").notNull(),
    proteinG: real("protein_g").notNull(),
    carbsG: real("carbs_g").notNull(),
    fatG: real("fat_g").notNull(),
    fiberG: real("fiber_g"),
    confidence: confidenceEnum("confidence").notNull(),
    uncertaintyReasons: jsonb("uncertainty_reasons").$type<string[]>().notNull().default([]),
    source: mealSourceEnum("source").notNull(),
    rawUserText: text("raw_user_text"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("meals_idempotency_key_uq").on(table.idempotencyKey), index("meals_occurred_at_idx").on(table.occurredAt)],
);

export const pendingMealEstimates = pgTable(
  "pending_meal_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 300 }).notNull(),
    items: jsonb("items").$type<{ name: string; portionDescription: string }[]>().notNull().default([]),
    caloriesBest: integer("calories_best").notNull(),
    caloriesLow: integer("calories_low").notNull(),
    caloriesHigh: integer("calories_high").notNull(),
    proteinG: real("protein_g").notNull(),
    carbsG: real("carbs_g").notNull(),
    fatG: real("fat_g").notNull(),
    fiberG: real("fiber_g"),
    confidence: confidenceEnum("confidence").notNull(),
    uncertaintyReasons: jsonb("uncertainty_reasons").$type<string[]>().notNull().default([]),
    source: mealSourceEnum("source").notNull(),
    rawUserText: text("raw_user_text"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    mealId: uuid("meal_id").references(() => meals.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pending_meals_idempotency_key_uq").on(table.idempotencyKey),
    index("pending_meals_expires_at_idx").on(table.expiresAt),
    index("pending_meals_created_at_idx").on(table.createdAt),
  ],
);

export const userSettings = pgTable("user_settings", {
  id: varchar("id", { length: 40 }).primaryKey(),
  calorieTarget: integer("calorie_target").notNull().default(2200),
  proteinTargetG: real("protein_target_g").notNull().default(160),
  timezone: varchar("timezone", { length: 100 }).notNull().default("Asia/Kuala_Lumpur"),
  preferredUnits: varchar("preferred_units", { length: 20 }).$type<"metric" | "imperial">().notNull().default("metric"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: varchar("type", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    timeLocal: varchar("time_local", { length: 5 }),
    timezone: varchar("timezone", { length: 100 }).notNull(),
    daysOfWeek: integer("days_of_week").array().notNull(),
    deliveryChannel: varchar("delivery_channel", { length: 24 }).$type<"web_push" | "whatsapp" | "both">().notNull(),
    configuration: jsonb("configuration").$type<Record<string, string | number | boolean>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_preferences_type_uq").on(table.type)],
);

export const mealItems = pgTable("meal_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  mealId: uuid("meal_id").notNull().references(() => meals.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  portionDescription: varchar("portion_description", { length: 500 }).notNull(),
});

export const foodPresets = pgTable(
  "food_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 160 }).notNull(),
    label: varchar("label", { length: 300 }).notNull(),
    caloriesBest: integer("calories_best").notNull(),
    caloriesLow: integer("calories_low").notNull(),
    caloriesHigh: integer("calories_high").notNull(),
    proteinG: real("protein_g").notNull(),
    carbsG: real("carbs_g").notNull(),
    fatG: real("fat_g").notNull(),
    fiberG: real("fiber_g"),
    confidence: confidenceEnum("confidence").notNull(),
    uncertaintyReasons: jsonb("uncertainty_reasons").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("food_presets_normalized_name_uq").on(table.normalizedName)],
);

export const workouts = pgTable(
  "workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull(),
    status: workoutStatusEnum("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("workouts_idempotency_key_uq").on(table.idempotencyKey), index("workouts_started_at_idx").on(table.startedAt)],
);

export const exercises = pgTable(
  "exercises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workoutId: uuid("workout_id").notNull().references(() => workouts.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 160 }).notNull(),
    position: integer("position").notNull(),
  },
  (table) => [uniqueIndex("exercises_workout_name_uq").on(table.workoutId, table.normalizedName)],
);

export const workoutSets = pgTable(
  "workout_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id").notNull().references(() => exercises.id, { onDelete: "cascade" }),
    setNumber: integer("set_number").notNull(),
    weightKg: real("weight_kg"),
    reps: integer("reps").notNull(),
    rpe: real("rpe"),
    notes: text("notes"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workout_sets_idempotency_key_uq").on(table.idempotencyKey),
    uniqueIndex("workout_sets_exercise_number_uq").on(table.exerciseId, table.setNumber),
  ],
);

