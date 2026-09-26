-- Smaakregels: "gitaarbands met een jaren-90-randje, zoals Afghan Whigs".
-- Een LLM keurt elk nieuw event dat binnen de harde grenzen valt; het
-- oordeel blijft bewaard zodat hetzelfde event nooit twee keer wordt gekeurd.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS taste text;
CREATE TABLE IF NOT EXISTS alert_verdicts (
  alert_id text NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match boolean NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, event_id)
);
