CREATE TABLE "custom_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" varchar(200) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_favorites" (
	"user_id" uuid NOT NULL,
	"library_id" varchar(80) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "library_id" varchar(80);--> statement-breakpoint
ALTER TABLE "custom_exercises" ADD CONSTRAINT "custom_exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_favorites" ADD CONSTRAINT "exercise_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_exercises_user_key_uq" ON "custom_exercises" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_favorites_user_library_uq" ON "exercise_favorites" USING btree ("user_id","library_id");