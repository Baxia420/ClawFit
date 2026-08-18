ALTER TABLE "pending_meal_estimates" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"calorie_target" integer DEFAULT 2200 NOT NULL,
	"protein_target_g" real DEFAULT 160 NOT NULL,
	"timezone" varchar(100) DEFAULT 'Asia/Kuala_Lumpur' NOT NULL,
	"preferred_units" varchar(20) DEFAULT 'metric' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"time_local" varchar(5),
	"timezone" varchar(100) NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"delivery_channel" varchar(24) NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_type_uq" ON "notification_preferences" USING btree ("type");
