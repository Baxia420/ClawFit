import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const confidenceEnum = pgEnum("confidence", ["high", "medium", "low"]);
export const mealSourceEnum = pgEnum("meal_source", ["text", "photo", "preset", "manual"]);
export const workoutStatusEnum = pgEnum("workout_status", ["active", "finished"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  role: varchar("role", { length: 40 }).notNull().default("primary"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 40 }).notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("household_members_user_household_uq").on(table.householdId, table.userId)],
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull(),
    externalIdentifier: varchar("external_identifier", { length: 255 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_identities_provider_identifier_uq").on(table.provider, table.externalIdentifier),
    uniqueIndex("external_identities_user_google_uq").on(table.userId).where(sql`${table.provider} = 'google'`),
    index("external_identities_user_id_idx").on(table.userId),
  ],
);

export const meals = pgTable(
  "meals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
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
  (table) => [
    uniqueIndex("meals_user_idempotency_uq").on(table.userId, table.idempotencyKey),
    index("meals_occurred_at_idx").on(table.occurredAt),
    index("meals_user_id_occurred_at_idx").on(table.userId, table.occurredAt),
  ],
);

export const pendingMealEstimates = pgTable(
  "pending_meal_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
    scopeKey: varchar("scope_key", { length: 200 }).notNull(),
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
    uniqueIndex("pending_meals_user_scope_idempotency_uq").on(table.userId, table.scopeKey, table.idempotencyKey),
    index("pending_meals_scope_created_at_idx").on(table.scopeKey, table.createdAt),
    index("pending_meals_expires_at_idx").on(table.expiresAt),
    index("pending_meals_created_at_idx").on(table.createdAt),
    index("pending_meals_user_id_idx").on(table.userId),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
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
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  (table) => [uniqueIndex("notification_preferences_user_type_uq").on(table.userId, table.type)],
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
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  (table) => [uniqueIndex("food_presets_user_normalized_name_uq").on(table.userId, table.normalizedName)],
);

export const workouts = pgTable(
  "workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    status: workoutStatusEnum("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workouts_user_idempotency_uq").on(table.userId, table.idempotencyKey),
    index("workouts_started_at_idx").on(table.startedAt),
    index("workouts_user_id_started_at_idx").on(table.userId, table.startedAt),
    uniqueIndex("workouts_user_active_uq").on(table.userId).where(sql`${table.status} = 'active'`),
  ],
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
    uniqueIndex("workout_sets_exercise_idempotency_uq").on(table.exerciseId, table.idempotencyKey),
    uniqueIndex("workout_sets_exercise_number_uq").on(table.exerciseId, table.setNumber),
  ],
);
