CREATE TYPE "confidence" AS ENUM ('high', 'medium', 'low');
CREATE TYPE "meal_source" AS ENUM ('text', 'photo', 'preset', 'manual');
CREATE TYPE "workout_status" AS ENUM ('active', 'finished');

CREATE TABLE "meals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "label" varchar(300) NOT NULL,
  "calories_best" integer NOT NULL,
  "calories_low" integer NOT NULL,
  "calories_high" integer NOT NULL,
  "protein_g" real NOT NULL,
  "carbs_g" real NOT NULL,
  "fat_g" real NOT NULL,
  "fiber_g" real,
  "confidence" "confidence" NOT NULL,
  "uncertainty_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source" "meal_source" NOT NULL,
  "raw_user_text" text,
  "idempotency_key" varchar(200) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "meals_idempotency_key_uq" ON "meals" ("idempotency_key");
CREATE INDEX "meals_occurred_at_idx" ON "meals" ("occurred_at");

CREATE TABLE "meal_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meal_id" uuid NOT NULL REFERENCES "meals"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL,
  "portion_description" varchar(500) NOT NULL
);

CREATE TABLE "food_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(160) NOT NULL,
  "normalized_name" varchar(160) NOT NULL,
  "label" varchar(300) NOT NULL,
  "calories_best" integer NOT NULL,
  "calories_low" integer NOT NULL,
  "calories_high" integer NOT NULL,
  "protein_g" real NOT NULL,
  "carbs_g" real NOT NULL,
  "fat_g" real NOT NULL,
  "fiber_g" real,
  "confidence" "confidence" NOT NULL,
  "uncertainty_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "food_presets_normalized_name_uq" ON "food_presets" ("normalized_name");

CREATE TABLE "workouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(120) NOT NULL,
  "status" "workout_status" DEFAULT 'active' NOT NULL,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "idempotency_key" varchar(200) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "workouts_idempotency_key_uq" ON "workouts" ("idempotency_key");
CREATE INDEX "workouts_started_at_idx" ON "workouts" ("started_at");

CREATE TABLE "exercises" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workout_id" uuid NOT NULL REFERENCES "workouts"("id") ON DELETE CASCADE,
  "name" varchar(160) NOT NULL,
  "normalized_name" varchar(160) NOT NULL,
  "position" integer NOT NULL
);
CREATE UNIQUE INDEX "exercises_workout_name_uq" ON "exercises" ("workout_id", "normalized_name");

CREATE TABLE "workout_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "exercise_id" uuid NOT NULL REFERENCES "exercises"("id") ON DELETE CASCADE,
  "set_number" integer NOT NULL,
  "weight_kg" real,
  "reps" integer NOT NULL,
  "rpe" real,
  "notes" text,
  "occurred_at" timestamptz NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "workout_sets_idempotency_key_uq" ON "workout_sets" ("idempotency_key");
CREATE UNIQUE INDEX "workout_sets_exercise_number_uq" ON "workout_sets" ("exercise_id", "set_number");

