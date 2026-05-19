-- occurrences krijgen een eigen venueId. Filosofie verschuift: events
-- beschrijven "wat speelt" (Anora), occurrences "wanneer + waar" (Eye
-- woensdag 19:30, Pathé donderdag 21:00). Voor concerts/theater blijft
-- de relatie 1-op-1 (event-venue == occurrence-venue), voor films
-- ontkoppelen we zodat één 'Anora'-event meerdere bioscopen kan dekken.
--
-- Bestaande events.venueId blijft staan als "primary venue" fallback.
-- Bestaande occurrences krijgen via backfill events.venueId zodat alle
-- reads naadloos op occurrence-niveau kunnen overstappen.

ALTER TABLE "occurrences"
  ADD COLUMN IF NOT EXISTS "venue_id" text;

-- Backfill: kopieer events.venueId naar bestaande occurrences.
UPDATE "occurrences" o
SET "venue_id" = e."venue_id"
FROM "events" e
WHERE o."event_id" = e."id"
  AND o."venue_id" IS NULL;

-- Pas daarna de FK toe (na backfill, anders zou een occurrence zonder
-- venueId de FK al moeten valideren).
ALTER TABLE "occurrences"
  ADD CONSTRAINT "occurrences_venue_id_venues_id_fk"
  FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id")
  ON DELETE set null;

CREATE INDEX IF NOT EXISTS "occurrences_venue_idx"
  ON "occurrences" ("venue_id");
