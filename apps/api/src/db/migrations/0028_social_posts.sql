-- Sociale automatisering: 3 dagelijkse IG-posts genereren we uit het
-- event-aanbod. Eén rij = één post (single of carousel). Mens-in-de-loop
-- approval in fase 1: cron genereert 's ochtends een concept (status
-- 'draft'), admin keurt goed (→ 'approved'), 's middags publiceert het
-- naar IG (→ 'posted' of 'failed').
--
-- event_ids is een array zodat één rij een carousel met meerdere events
-- kan vertegenwoordigen. Voor single-posts is het 1-elements.
-- image_urls volgt dezelfde shape (1 per event-slide; carousel-cover en
-- outro tellen mee als extra elementen).

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" text PRIMARY KEY,
  "slot" text NOT NULL CHECK ("slot" IN ('morning', 'afternoon', 'evening')),
  "event_ids" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "image_urls" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "caption" text,
  "ig_media_id" text,
  "scheduled_for" timestamp with time zone NOT NULL,
  "posted_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'draft'
    CHECK ("status" IN ('draft', 'approved', 'posted', 'skipped', 'failed')),
  "error" text,
  "meta" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "social_posts_status_idx"
  ON "social_posts" ("status");
CREATE INDEX IF NOT EXISTS "social_posts_scheduled_for_idx"
  ON "social_posts" ("scheduled_for");
CREATE INDEX IF NOT EXISTS "social_posts_posted_at_idx"
  ON "social_posts" ("posted_at");
-- GIN op event_ids — voor dedup-query "is dit event in laatste 14d gepost".
CREATE INDEX IF NOT EXISTS "social_posts_event_ids_gin"
  ON "social_posts" USING gin ("event_ids");
