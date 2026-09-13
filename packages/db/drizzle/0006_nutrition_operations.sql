CREATE TYPE "public"."nutrition_operation_status" AS ENUM('in_progress', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "nutrition_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation_id" varchar(200) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"status" "nutrition_operation_status" DEFAULT 'in_progress' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"owner_token" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nutrition_operations" ADD CONSTRAINT "nutrition_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "nutrition_operations_user_operation_uq" ON "nutrition_operations" USING btree ("user_id","operation_id");
--> statement-breakpoint
CREATE INDEX "nutrition_operations_expires_at_idx" ON "nutrition_operations" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "nutrition_operations_user_created_at_idx" ON "nutrition_operations" USING btree ("user_id","created_at");
--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "calories" integer;
--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "protein_g" real;
--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "carbs_g" real;
--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "fat_g" real;
--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "fiber_g" real;
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
