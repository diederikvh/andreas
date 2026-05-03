CREATE TYPE "public"."saves_visibility" AS ENUM('friends', 'private');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "saves_visibility" "saves_visibility" DEFAULT 'friends' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discoverable" boolean DEFAULT true NOT NULL;