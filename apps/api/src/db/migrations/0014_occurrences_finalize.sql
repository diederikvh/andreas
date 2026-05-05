ALTER TABLE "invites" DROP CONSTRAINT "invites_event_id_events_id_fk";
--> statement-breakpoint
DROP INDEX "events_starts_at_idx";--> statement-breakpoint
DROP INDEX "invites_event_idx";--> statement-breakpoint
DROP INDEX "invites_unique_idx";--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "occurrence_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "invites_occurrence_idx" ON "invites" USING btree ("occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_unique_idx" ON "invites" USING btree ("from_user_id","to_user_id","occurrence_id");--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "starts_at";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "ends_at";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "price_cents";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "price_note";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "ticket_url";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "event_id";