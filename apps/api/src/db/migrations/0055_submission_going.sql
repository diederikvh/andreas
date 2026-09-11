-- Aanmeldingen waar je heen kan gaan vóórdat er een echt event bestaat —
-- fase 6.2 van docs/share-naar-andreas.md.
--
-- Waarom niet `events.published = false`: er staan 136 selects op
-- `schema.events` in deze API, inclusief de MCP-gids, de social-posts en de
-- zoek-retrieval. Eén vergeten filter en iemands typefout staat in een
-- Instagram-post. Een aanmelding blijft dus een aanmelding; je kan er alleen
-- heen gaan.
--
-- `event_id` is de brug: zodra een mens de aanmelding goedkeurt en er een
-- echt event van maakt, staat hier waar het heen ging, en verhuizen de
-- going-rijen mee naar `attendance`.
ALTER TABLE event_submissions
  ADD COLUMN IF NOT EXISTS event_id text REFERENCES events(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS submission_going (
  submission_id text NOT NULL REFERENCES event_submissions(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, user_id)
);

CREATE INDEX IF NOT EXISTS submission_going_user_idx ON submission_going (user_id);
