-- Stad als eigen dimensie op venues.
--
-- `wijk` was tot nu toe én stadsdeel én noodgreep voor alles buiten de
-- ring: amstelveen, zaandam, haarlem en diemen stonden er als "wijk" in
-- naast centrum, noord en zuid. Dat hield het zolang alles binnen een
-- half uur van de Dam lag, maar met De Roma in Antwerpen en Utrecht en
-- Rotterdam op de planning gaat dat niet meer.
--
-- Vanaf nu: `city` is de stad, `wijk` is het stadsdeel bínnen een stad.
-- Voor de zeven venues in een buitengemeente betekent dat een eigen stad
-- én een lege wijk — anders staat Haarlem twee keer in hetzelfde filter.
--
-- Enum en geen vrije tekst, net als `wijk`: de lijst groeit met opzet,
-- niet vanzelf. Een nieuwe stad is een besluit, en een enum voorkomt dat
-- er ooit zowel 'Utrecht' als 'utrecht' in de database staat. Uitbreiden
-- gaat met ALTER TYPE ... ADD VALUE, zoals migratie 0021 al deed.

CREATE TYPE "public"."city" AS ENUM (
  'amsterdam',
  'amstelveen',
  'diemen',
  'zaandam',
  'haarlem',
  'utrecht',
  'rotterdam',
  'den-haag',
  'eindhoven',
  'groningen',
  'antwerpen'
);

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "city" "public"."city" NOT NULL DEFAULT 'amsterdam';

-- Buitengemeenten: van wijk naar stad.
UPDATE "venues" SET "city" = 'amstelveen', "wijk" = NULL WHERE "wijk" = 'amstelveen';
UPDATE "venues" SET "city" = 'diemen',     "wijk" = NULL WHERE "wijk" = 'diemen';
UPDATE "venues" SET "city" = 'zaandam',    "wijk" = NULL WHERE "wijk" = 'zaandam';
UPDATE "venues" SET "city" = 'haarlem',    "wijk" = NULL WHERE "wijk" = 'haarlem';

UPDATE "venues" SET "city" = 'antwerpen' WHERE "id" = 'de-roma';

-- ponytail: de vier buitengemeente-waarden blijven in het wijk-enum
-- staan. Postgres kan een enum-waarde niet droppen zonder het type te
-- hermaken, en ze staan nergens meer in de data. Opruimen als er ooit
-- een reden is om dat type toch aan te raken.
