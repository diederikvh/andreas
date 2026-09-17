-- Waarvoor herinneringen gelden: het hartje, "ik ga", of allebei.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_for_saves boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_for_going boolean NOT NULL DEFAULT true;
