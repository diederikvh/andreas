-- One-shot reply-bericht dat de invitee meestuurt bij accept of decline.
-- Wordt opgenomen in de push naar de inviter zodat een persoonlijke
-- reactie zichtbaar wordt zonder messaging-platform-functionaliteit.
ALTER TABLE "invites" ADD COLUMN "reply_message" text;
