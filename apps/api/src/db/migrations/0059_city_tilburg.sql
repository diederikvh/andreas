-- Tilburg erbij voor 013.
--
-- ALTER TYPE ... ADD VALUE, zoals 0058 al aankondigde. Volgorde binnen
-- het enum doet er niet toe: de app sorteert steden op label, niet op
-- enum-positie.
ALTER TYPE "public"."city" ADD VALUE IF NOT EXISTS 'tilburg';
