-- Gedeelde rate-limit-store voor better-auth (storage: 'database'). Vervangt
-- de in-memory store die per Fly-machine telde — zo klopt de OTP/SMS-rate-
-- limit ook bij autoscale (>1 machine). Model `rateLimit`: key/count/
-- lastRequest (ms-since-epoch). id is de primary key.
CREATE TABLE IF NOT EXISTS rate_limit (
  id text PRIMARY KEY,
  key text,
  count integer,
  last_request bigint
);
CREATE INDEX IF NOT EXISTS rate_limit_key_idx ON rate_limit (key);
