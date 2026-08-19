ALTER TABLE "pending_meal_estimates" ADD COLUMN "scope_key" varchar(200);
--> statement-breakpoint
UPDATE "pending_meal_estimates" SET "scope_key" = 'legacy:unscoped' WHERE "scope_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "pending_meal_estimates" ALTER COLUMN "scope_key" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "pending_meals_idempotency_key_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_meals_scope_idempotency_uq" ON "pending_meal_estimates" USING btree ("scope_key", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "pending_meals_scope_created_at_idx" ON "pending_meal_estimates" USING btree ("scope_key", "created_at");
