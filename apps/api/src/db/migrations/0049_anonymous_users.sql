-- Anoniem-eerst: bij eerste app-start krijgt iedereen een echte user-rij
-- zonder telefoonnummer, zodat saves/dismisses/follows meteen ergens aan
-- kunnen hangen en álle bestaande endpoints (die op een sessie leunen)
-- ongewijzigd blijven werken.
--
-- phone_number moet daarvoor NULL kunnen zijn. De unique index blijft
-- geldig: Postgres beschouwt NULLs als onderling ongelijk, dus meerdere
-- anonieme rijen botsen niet.
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;

-- Vlag van de better-auth anonymous-plugin. NULL/false = echt account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

-- Anonieme users hebben geen nummer maar wél een gegenereerd e-mailadres
-- (plugin-vereiste). Die kolom had nog geen unique index; better-auth
-- verwacht 'm wel voor de e-mail-identiteit.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email) WHERE email IS NOT NULL;
