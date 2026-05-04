CREATE TYPE "public"."venue_scene" AS ENUM('mainstream', 'alternatief', 'underground', 'fringe');--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "scene" "venue_scene";