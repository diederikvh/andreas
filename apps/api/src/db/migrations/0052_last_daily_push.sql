-- Dubbel-verzend-slot voor de dagelijkse aanwinsten-push. Zie de
-- toelichting bij `users.lastDailyPushAt` in schema.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_push_at timestamptz;
