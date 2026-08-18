CREATE TABLE "pending_meal_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(300) NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"meal_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ADD CONSTRAINT "pending_meal_estimates_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_meals_idempotency_key_uq" ON "pending_meal_estimates" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "pending_meals_expires_at_idx" ON "pending_meal_estimates" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "pending_meals_created_at_idx" ON "pending_meal_estimates" USING btree ("created_at");
