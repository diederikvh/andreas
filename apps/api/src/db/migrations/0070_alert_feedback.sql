-- Feedback op meldingen: "die klopte niet" / "die had je moeten melden".
-- Gecorrigeerde oordelen gaan als voorbeelden mee naar de keurder.
ALTER TABLE alert_verdicts ADD COLUMN IF NOT EXISTS feedback boolean;
ALTER TABLE alert_verdicts ADD COLUMN IF NOT EXISTS feedback_note text;
ALTER TABLE alert_verdicts ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
