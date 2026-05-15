-- Activity-tracking: laatste authed API-call per user. Voedt
-- DAU/WAU/MAU op het admin-insights-dashboard. Update gebeurt
-- throttled (1× per uur) in de GET /me endpoint.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
