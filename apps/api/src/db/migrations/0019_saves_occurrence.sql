-- Saves verhuizen van event-level naar occurrence-level. Een save is
-- nu een specifiek MOMENT (woensdagvoorstelling van een film, één
-- maandag van een wekelijks feest, de openingsavond van een
-- tentoonstelling) ipv het abstracte event.
--
-- Bestaande saves migreren naar de eerstvolgende toekomstige occurrence
-- van hetzelfde event; geen toekomst meer? laatste verlopen occurrence
-- (zodat de save niet stilletjes verdwijnt voor recent voorbije events,
-- bv. een save van gisteren die in de Gered "Vorige"-sectie hoort).
-- Geen enkele occurrence? save vervalt.

ALTER TABLE "saves" ADD COLUMN "occurrence_id" text;
--> statement-breakpoint
UPDATE "saves" s
SET "occurrence_id" = (
  SELECT o.id
  FROM "occurrences" o
  WHERE o.event_id = s.event_id
  ORDER BY
    CASE WHEN o.starts_at >= NOW() THEN 0 ELSE 1 END,
    CASE WHEN o.starts_at >= NOW() THEN o.starts_at END ASC,
    CASE WHEN o.starts_at < NOW() THEN o.starts_at END DESC
  LIMIT 1
);
--> statement-breakpoint
DELETE FROM "saves" WHERE "occurrence_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saves" ALTER COLUMN "occurrence_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "saves" DROP CONSTRAINT "saves_user_id_event_id_pk";
--> statement-breakpoint
DROP INDEX "saves_event_idx";
--> statement-breakpoint
ALTER TABLE "saves" DROP CONSTRAINT "saves_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "saves" DROP COLUMN "event_id";
--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_user_id_occurrence_id_pk" PRIMARY KEY ("user_id", "occurrence_id");
--> statement-breakpoint
CREATE INDEX "saves_occurrence_idx" ON "saves" USING btree ("occurrence_id");
