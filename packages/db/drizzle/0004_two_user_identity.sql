CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"role" varchar(40) DEFAULT 'primary' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(40) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "household_members_user_household_uq" ON "household_members" USING btree ("household_id","user_id");
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"external_identifier" varchar(255) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_identifier_uq" ON "external_identities" USING btree ("provider","external_identifier");
--> statement-breakpoint
CREATE INDEX "external_identities_user_id_idx" ON "external_identities" USING btree ("user_id");
--> statement-breakpoint
INSERT INTO "households" ("id", "name")
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Household')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "users" ("id", "display_name", "role", "active")
VALUES ('00000000-0000-0000-0000-000000000002', 'Primary User', 'primary', true)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "users" ("id", "display_name", "role", "active")
VALUES ('00000000-0000-0000-0000-000000000003', 'Partner', 'partner', true)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "household_members" ("household_id", "user_id", "role")
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'owner'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'member')
ON CONFLICT ("household_id", "user_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "meals" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "meals" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "meals_user_id_occurred_at_idx" ON "meals" USING btree ("user_id","occurred_at");
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "pending_meal_estimates" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ADD CONSTRAINT "pending_meal_estimates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pending_meals_user_id_idx" ON "pending_meal_estimates" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "food_presets" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "food_presets" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "food_presets" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "food_presets" ADD CONSTRAINT "food_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "food_presets_normalized_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "food_presets_user_normalized_name_uq" ON "food_presets" USING btree ("user_id","normalized_name");
--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "workouts" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "workouts" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workouts_user_id_started_at_idx" ON "workouts" USING btree ("user_id","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workouts_user_active_uq" ON "workouts" USING btree ("user_id") WHERE ("status" = 'active');
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "user_settings" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_pkey";
--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "id";
--> statement-breakpoint
ALTER TABLE "user_settings" ADD PRIMARY KEY ("user_id");
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "user_settings" ("user_id", "calorie_target", "protein_target_g", "timezone", "preferred_units")
VALUES ('00000000-0000-0000-0000-000000000003', 2000, 120, 'Asia/Kuala_Lumpur', 'metric')
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "notification_preferences" SET "user_id" = '00000000-0000-0000-0000-000000000002' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "notification_preferences_type_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_type_uq" ON "notification_preferences" USING btree ("user_id","type");
