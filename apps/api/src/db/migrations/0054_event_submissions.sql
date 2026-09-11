-- Gebruikers die een event aanmelden dat Andreas nog niet kent (fase 6 van
-- docs/share-naar-andreas.md). Bewust een eigen tabel en geen
-- `events.published = false`: een onvolledige rij in `events` zou overal
-- weggefilterd moeten worden, en één vergeten filter = een half event in de
-- app.
--
-- Alleen de velden die de privacygrens doorkomen. Geen bestand, geen
-- OCR-tekst, geen ticketgegevens.
CREATE TABLE IF NOT EXISTS event_submissions (
  id           text PRIMARY KEY,
  title        text,
  artists      text[] NOT NULL DEFAULT ARRAY[]::text[],
  venue_name   text,
  venue_id     text REFERENCES venues(id) ON DELETE SET NULL,
  date         text,
  time         text,
  city         text,
  user_id      text REFERENCES users(id) ON DELETE SET NULL,
  source       save_source,
  status       text NOT NULL DEFAULT 'new',
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz
);

CREATE INDEX IF NOT EXISTS event_submissions_status_idx ON event_submissions (status);
CREATE INDEX IF NOT EXISTS event_submissions_created_idx ON event_submissions (created_at);
