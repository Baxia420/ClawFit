CREATE TYPE "public"."confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."meal_source" AS ENUM('text', 'photo', 'preset', 'manual');--> statement-breakpoint
CREATE TYPE "public"."workout_status" AS ENUM('active', 'finished');--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"normalized_name" varchar(160) NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"portion_description" varchar(500) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"set_number" integer NOT NULL,
	"weight_kg" real,
	"reps" integer NOT NULL,
	"rpe" real,
	"notes" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"status" "workout_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"idempotency_key" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sets" ADD CONSTRAINT "workout_sets_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_workout_name_uq" ON "exercises" USING btree ("workout_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "food_presets_normalized_name_uq" ON "food_presets" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "meals_idempotency_key_uq" ON "meals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "meals_occurred_at_idx" ON "meals" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sets_idempotency_key_uq" ON "workout_sets" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sets_exercise_number_uq" ON "workout_sets" USING btree ("exercise_id","set_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workouts_idempotency_key_uq" ON "workouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "workouts_started_at_idx" ON "workouts" USING btree ("started_at");