CREATE TYPE "public"."venue_capacity" AS ENUM('klein', 'middel', 'groot', 'xl');--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "capacity" "venue_capacity";