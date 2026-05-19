-- Groepsuitnodigingen + 3-status-respons.
--
-- Vervangt het 1-op-1 `invites`-model (status accepted|declined) door een
-- groep-aware schema waarin:
--   * één `invitations`-rij staat voor één verzending (1-op-1 of groep);
--   * `invitation_responses` per (uitgenodigde, invitation) een aparte
--     status bijhoudt — pending | going | maybe | not_going;
--   * de initiator default `going` is, maar kan dat naderhand wijzigen.
--
-- Bestaande `invites`-rijen worden in deze migratie eenmalig gekopieerd
-- naar de nieuwe tabellen (mapping accepted→going, declined→not_going).
-- De oude tabel blijft staan tot slice B mobile heeft omgezet; daarna
-- kunnen we 'm in een opvolgende migratie droppen.

-- ─── Enums ──────────────────────────────────────────────────────────────────
-- Geen IF NOT EXISTS voor CREATE TYPE in Postgres — als deze migratie
-- twee keer gerund wordt, faalt deze regel met "type already exists".
-- Dat is acceptabel: de rest van de migratie blijft idempotent.

CREATE TYPE "response_status" AS ENUM ('pending', 'going', 'maybe', 'not_going');

-- ─── Groepen ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "groups" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "creator_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "groups_creator_fk"
    FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "groups_creator_idx" ON "groups" ("creator_id");

CREATE TABLE IF NOT EXISTS "group_members" (
  "group_id" text NOT NULL,
  "user_id" text NOT NULL,
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Lid heeft de groep verlaten of is gekickt. Niet hard-deleted zodat
  -- responses op oude invitations bewaard blijven (zie group_invite-
  -- snapshot-gedrag in routes/invitations).
  "left_at" timestamp with time zone,
  -- Eigen mute-toggle: notificaties uit zonder de groep te verlaten.
  "muted_at" timestamp with time zone,
  CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id", "user_id"),
  CONSTRAINT "group_members_group_fk"
    FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade,
  CONSTRAINT "group_members_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "group_members_user_idx" ON "group_members" ("user_id");

-- ─── Invitations ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" text PRIMARY KEY,
  "from_user_id" text NOT NULL,
  "occurrence_id" text NOT NULL,
  -- NULL = 1-op-1 (recipient zit in invitation_responses). Anders = groep.
  "group_id" text,
  "message" text,
  -- Initiator kan een verstuurde uitnodiging intrekken (spec: ja).
  -- Soft-delete zodat reminder/save-cleanup-logic kan opruimen voordat
  -- het record echt weg is. NULL = actief.
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_from_fk"
    FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "invitations_occurrence_fk"
    FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade,
  CONSTRAINT "invitations_group_fk"
    FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "invitations_from_idx" ON "invitations" ("from_user_id");
CREATE INDEX IF NOT EXISTS "invitations_occurrence_idx" ON "invitations" ("occurrence_id");
CREATE INDEX IF NOT EXISTS "invitations_group_idx" ON "invitations" ("group_id");

-- Voorkomt dat dezelfde initiator twee invitations voor dezelfde
-- (occurrence, groep) aanmaakt. Voor 1-op-1 gebruiken we een aparte
-- partial unique op (from, occurrence, NULL) — gerealiseerd via een
-- expression-index zodat NULL-groupId als één key telt.
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_unique_group_idx"
  ON "invitations" ("from_user_id", "occurrence_id", "group_id")
  WHERE "group_id" IS NOT NULL;

-- ─── Invitation responses ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "invitation_responses" (
  "invitation_id" text NOT NULL,
  "user_id" text NOT NULL,
  "status" "response_status" NOT NULL DEFAULT 'pending',
  "reply_message" text,
  -- Per spec: één reminder per pending invitee. Niet-NULL = al gestuurd.
  "reminder_sent_at" timestamp with time zone,
  "responded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invitation_responses_pkey" PRIMARY KEY ("invitation_id", "user_id"),
  CONSTRAINT "invitation_responses_invitation_fk"
    FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade,
  CONSTRAINT "invitation_responses_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "invitation_responses_user_idx"
  ON "invitation_responses" ("user_id");
CREATE INDEX IF NOT EXISTS "invitation_responses_status_idx"
  ON "invitation_responses" ("status");

-- 1-op-1 unique: voor invitations zonder group_id mag een ontvanger maar
-- één keer voorkomen — dat is logisch al gegarandeerd door de invitation-
-- niveau unique-key, maar voor groep-invitations geldt nog dezelfde regel
-- (één response-rij per lid). PK dekt dat.

-- ─── Data-migratie ─────────────────────────────────────────────────────────
-- Kopieer bestaande `invites` één-op-één naar `invitations`+responses.
-- Idempotent via NOT EXISTS-check op `invitations.id`. Mapping:
--   pending  → recipient response 'pending'
--   accepted → recipient response 'going'
--   declined → recipient response 'not_going'
-- Initiator krijgt altijd een response-rij met status 'going'.

INSERT INTO "invitations" (id, from_user_id, occurrence_id, group_id, message, created_at)
SELECT i.id, i.from_user_id, i.occurrence_id, NULL, i.message, i.created_at
FROM "invites" i
WHERE NOT EXISTS (SELECT 1 FROM "invitations" inv WHERE inv.id = i.id);

-- Recipient response
INSERT INTO "invitation_responses" (invitation_id, user_id, status, reply_message, responded_at, created_at)
SELECT
  i.id,
  i.to_user_id,
  CASE i.status::text
    WHEN 'accepted' THEN 'going'::response_status
    WHEN 'declined' THEN 'not_going'::response_status
    ELSE 'pending'::response_status
  END,
  i.reply_message,
  CASE WHEN i.status::text IN ('accepted', 'declined') THEN i.created_at ELSE NULL END,
  i.created_at
FROM "invites" i
WHERE NOT EXISTS (
  SELECT 1 FROM "invitation_responses" r
  WHERE r.invitation_id = i.id AND r.user_id = i.to_user_id
);

-- Initiator response (going)
INSERT INTO "invitation_responses" (invitation_id, user_id, status, responded_at, created_at)
SELECT i.id, i.from_user_id, 'going'::response_status, i.created_at, i.created_at
FROM "invites" i
WHERE NOT EXISTS (
  SELECT 1 FROM "invitation_responses" r
  WHERE r.invitation_id = i.id AND r.user_id = i.from_user_id
);
