CREATE TYPE "public"."venue_follow_state" AS ENUM('volgen', 'blokken');--> statement-breakpoint
ALTER TABLE "venue_follows" ADD COLUMN "state" "venue_follow_state" DEFAULT 'volgen' NOT NULL;