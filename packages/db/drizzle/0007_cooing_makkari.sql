CREATE TABLE "body_weights" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"weight_kg" real NOT NULL,
	"notes" varchar(500) DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"weight_goal_kg" real
);
--> statement-breakpoint
CREATE TABLE "workout_routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"exercises" jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_schedule" (
	"user_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"routine_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "muscle_group" varchar(30);--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "routine_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "body_weights" ADD CONSTRAINT "body_weights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_profiles" ADD CONSTRAINT "training_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_routines" ADD CONSTRAINT "workout_routines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_schedule" ADD CONSTRAINT "workout_schedule_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "body_weights_user_day_uq" ON "body_weights" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "routines_user_key_uq" ON "workout_routines" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "routines_user_id_uq" ON "workout_routines" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_user_day_uq" ON "workout_schedule" USING btree ("user_id","weekday");
--> statement-breakpoint
ALTER TABLE "workout_schedule" ADD CONSTRAINT "workout_schedule_user_id_routine_id_workout_routines_user_id_id_fk" FOREIGN KEY ("user_id","routine_id") REFERENCES "public"."workout_routines"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
