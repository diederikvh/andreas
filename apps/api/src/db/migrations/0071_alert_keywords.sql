-- Trefwoorden op een melding ("90s", "grunge"): hele woorden in titel of
-- beschrijving. Vervangt de keurder: de AI van de gebruiker vertaalt smaak
-- via de MCP naar genres, verwante artiesten en trefwoorden.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS keywords text[];
