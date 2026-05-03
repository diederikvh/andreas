CREATE TYPE "public"."day_night" AS ENUM('day', 'night', 'both');--> statement-breakpoint
CREATE TYPE "public"."venue_type" AS ENUM('galerie', 'museum', 'podium', 'club', 'film', 'ruimte', 'boekhandel-cafe');--> statement-breakpoint
CREATE TYPE "public"."wijk" AS ENUM('centrum', 'noord', 'oost', 'west', 'zuid', 'zuidoost', 'nieuw-west');--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "type" "venue_type";--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "day_night" "day_night";--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "wijk" "wijk";--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "subtype" text[] DEFAULT ARRAY[]::text[] NOT NULL;