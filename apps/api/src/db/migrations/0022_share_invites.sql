CREATE TABLE IF NOT EXISTS "share_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"event_id" text,
	"venue_id" text,
	"token" text NOT NULL UNIQUE,
	"claimed_by_user_id" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_invites_token_idx" ON "share_invites" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_invites_from_idx" ON "share_invites" ("from_user_id");
