ALTER TABLE "events" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "events_featured_idx" ON "events" USING btree ("featured");