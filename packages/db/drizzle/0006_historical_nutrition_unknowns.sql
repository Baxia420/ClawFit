ALTER TABLE "meals" ALTER COLUMN "calories_best" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "calories_low" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "calories_high" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "protein_g" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "carbs_g" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meals" ALTER COLUMN "fat_g" DROP NOT NULL;