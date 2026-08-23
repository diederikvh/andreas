-- Wanneer heeft deze gebruiker /new voor het laatst bekeken?
--
-- Stond alleen in AsyncStorage op het toestel, dus je "sinds je vorige
-- bezoek"-venster ging verloren bij een nieuwe telefoon of een
-- herinstallatie — óók als je een account had. Op de user-rij reist het
-- venster mee, en dat is een van de concrete redenen om er één te maken.
--
-- Losstaand van `last_seen_at`: dat is algemene activiteit (DAU/MAU),
-- dit gaat specifiek over de nieuw-lijst.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_new_at timestamptz;
