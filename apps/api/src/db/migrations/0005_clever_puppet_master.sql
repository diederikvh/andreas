CREATE TABLE "events_in_series" (
	"event_id" text NOT NULL,
	"series_id" text NOT NULL,
	CONSTRAINT "events_in_series_event_id_series_id_pk" PRIMARY KEY("event_id","series_id")
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"categories" "event_category"[] DEFAULT ARRAY[]::event_category[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "events_in_series" ADD CONSTRAINT "events_in_series_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_in_series" ADD CONSTRAINT "events_in_series_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eis_series_idx" ON "events_in_series" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "eis_event_idx" ON "events_in_series" USING btree ("event_id");