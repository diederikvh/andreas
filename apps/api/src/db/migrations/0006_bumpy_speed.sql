ALTER TABLE "events" ADD COLUMN "published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "published" boolean DEFAULT true NOT NULL;