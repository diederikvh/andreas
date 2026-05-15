-- Smaak-spiegel + leerloops, fase 1: data-fundering.
--
-- Wat er gebeurt:
--   1. Nieuwe enums `mirror_visibility` en `save_source`.
--   2. `users.mirror_visibility` kolom — aparte opt-in voor de publieke
--      spiegel-subset, los van saves-visibility. Default 'private'.
--   3. `saves.source` kolom — welk scherm/route leverde de save op.
--      Nullable: bestaande rijen krijgen geen waarde (we doen geen
--      retro-fill). Nieuwe call-sites moeten 'm meegeven.
--   4. Nieuwe `dismisses` tabel — left-swipes uit /op-gevoel die
--      persistent worden, zodat we ze niet opnieuw tonen én ze als
--      input kunnen gebruiken voor het smaak-profiel.
--
-- Alle stappen idempotent via IF NOT EXISTS / DO-blocks zodat we 'm
-- veilig nog eens kunnen draaien.

DO $$ BEGIN
  CREATE TYPE "public"."mirror_visibility" AS ENUM('friends', 'private');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."save_source" AS ENUM(
    'venue',
    'friend',
    'search',
    'op-gevoel',
    'avond',
    'agenda',
    'kaart',
    'series',
    'gered',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mirror_visibility" "mirror_visibility"
  NOT NULL DEFAULT 'private';

ALTER TABLE "saves"
  ADD COLUMN IF NOT EXISTS "source" "save_source";

CREATE TABLE IF NOT EXISTS "dismisses" (
  "user_id" text NOT NULL,
  "occurrence_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "source" "save_source" NOT NULL DEFAULT 'op-gevoel',
  CONSTRAINT "dismisses_pkey" PRIMARY KEY ("user_id", "occurrence_id"),
  CONSTRAINT "dismisses_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "dismisses_occurrence_id_occurrences_id_fk"
    FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "dismisses_occurrence_idx"
  ON "dismisses" ("occurrence_id");
