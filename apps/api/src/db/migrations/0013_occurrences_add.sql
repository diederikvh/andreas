CREATE TYPE "public"."event_kind" AS ENUM('show', 'exhibition');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('scheduled', 'cancelled', 'sold_out');--> statement-breakpoint
CREATE TABLE "occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"price_cents" integer,
	"price_note" text,
	"ticket_url" text,
	"room" text,
	"lineup" jsonb,
	"status" "occurrence_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "starts_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "kind" "event_kind" DEFAULT 'show' NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "occurrence_id" text;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "occurrences_event_idx" ON "occurrences" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "occurrences_starts_at_idx" ON "occurrences" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "occurrences_event_starts_at_idx" ON "occurrences" USING btree ("event_id","starts_at");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade ON UPDATE no action;